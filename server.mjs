// server.mjs — kasada-solver: a mint-only HTTP service.
//
// Drives a real (headed) Chrome over raw CDP via ./driver.mjs and mints Kasada
// tokens (x-kpsdk-ct/cd/h/v + cookies + UA) for ANY Kasada-protected URL the
// caller supplies. No logins, no verdicts, no sites, no pool, no token buffer.
//
// Mint chain (per request):
//   ensureBrowser (lazy, memoized Chrome boot)
//     -> fresh incognito context createBrowserContext({proxyServer}) + newPage
//     -> optional page.authenticate / setUserAgent
//     -> detectPjsUrl (only when this origin's Kasada script URL is unknown yet;
//        throwaway context; cached per-origin afterwards)
//     -> runSemiVm(page,{skipLogin:true,target}) arms the page (CDP Fetch
//        stub-serve on the target origin embedding p.js + KPSDK.configure,
//        waits kpsdk-ready)
//     -> mintTokens (Fetch.enable on the endpoint path, in-page fetch, read the
//        x-kpsdk-* headers off the paused request, failRequest so it never
//        lands, collect UA/cookies/egressIp)
//
// Plain node:http, no framework, no build step. ws is the only dependency
// (pulled in by driver.mjs). Config is env-only; nothing depends on CWD.

import http from 'node:http';
import driver from './driver.mjs';
import { findChrome, checkDisplay, parseProxy, proxyServerUrl } from './lib.mjs';
import { runSemiVm, mintTokens, detectPjsUrl, buildLaunchArgs, minimizeWindow } from './semi-vm-core.mjs';
import { resolveTarget, cachePjsUrl } from './targets.mjs';

// ---------------------------------------------------------------------------
// Config (env with defaults; no .env file is read)
// ---------------------------------------------------------------------------
const PORT = Number(process.env.PORT) || 8787;
const MAX_CONCURRENT = Math.max(1, Number(process.env.MAX_CONCURRENT) || 2);
const HIDDEN = process.env.HIDDEN !== '0'; // offscreen + start-minimized Chrome (default on)
// covers a 45s slow arm + mint + the 3s-bounded egress probe
const SESSION_TIMEOUT_MS = 90_000;

const CHROME = findChrome();
const DISPLAY = checkDisplay();

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------
let browser = null;
let _bootPromise = null;
let shuttingDown = false;
let _kpsdkVersion = null; // last x-kpsdk-v seen on a minted token (in-memory only)

const stats = {
  startedAt: Date.now(),
  requestsTotal: 0,
  requestsActive: 0,
  requestsPassed: 0,
  requestsFailed: 0,
  requestsRejectedBusy: 0,
};

function log(tag, msg) {
  console.log(`[${new Date().toISOString()}] [${tag}] ${msg}`);
}

// ---------------------------------------------------------------------------
// Browser lifecycle — lazy boot, memoized; concurrent callers share the promise
// ---------------------------------------------------------------------------
function attachDisconnectHandler(b) {
  b.on('disconnected', () => {
    if (shuttingDown) return; // expected during graceful shutdown
    log('BROWSER', 'disconnected unexpectedly - will relaunch on the next request');
    browser = null;
    _bootPromise = null;
  });
}

async function bootBrowser() {
  if (!CHROME) {
    throw new Error('Chrome not found - install Google Chrome or set CHROME_BIN to its executable');
  }
  log('BROWSER', 'launching Chrome (headed)...');
  const launchOpts = {
    executablePath: CHROME,
    // the raw-CDP driver adds its own unique --user-data-dir at spawn
    args: buildLaunchArgs(null, { hidden: HIDDEN }),
  };
  let launchErr = null;
  for (let attempt = 1; attempt <= 2; attempt++) {
    try { browser = await driver.launch(launchOpts); launchErr = null; break; }
    catch (e) {
      launchErr = e;
      if (attempt < 2) {
        log('ERR', `Chrome launch attempt ${attempt}/2 failed (${String(e?.message || e).slice(0, 140)}); retrying in 2s...`);
        await new Promise((r) => setTimeout(r, 2000));
      }
    }
  }
  if (launchErr) throw launchErr;
  attachDisconnectHandler(browser);
  log('BROWSER', `Chrome up (PID=${browser.process()?.pid || '?'})`);
}

function ensureBrowser() {
  if (browser && browser.connected !== false) return Promise.resolve();
  if (!_bootPromise) {
    const t0 = Date.now();
    _bootPromise = bootBrowser()
      .then(() => log('BOOT', `Chrome ready in ${Date.now() - t0}ms`))
      .catch((e) => { _bootPromise = null; throw e; }); // allow a later retry after a failed launch
  }
  return _bootPromise;
}

function noteKpsdkVersion(v) {
  if (v && typeof v === 'string' && v !== _kpsdkVersion) {
    if (_kpsdkVersion) log('KPSDK', `SDK version changed: ${_kpsdkVersion} -> ${v}`);
    _kpsdkVersion = v;
  }
}

// ---------------------------------------------------------------------------
// HTTP helpers (modeled on the proven engine)
// ---------------------------------------------------------------------------
function send(res, status, body, headers = {}) {
  if (res.headersSent || res.writableEnded) return;
  const isJson = typeof body !== 'string';
  res.writeHead(status, { 'content-type': isJson ? 'application/json' : 'text/plain', ...headers });
  res.end(isJson ? JSON.stringify(body) : body);
}

async function readBody(req, limitBytes = 16 * 1024, timeoutMs = 15_000) {
  let bytes = 0;
  const chunks = [];
  // Bound the read: a stalled/slow client must not hold the socket open forever.
  const to = setTimeout(() => { try { req.destroy(new Error('request body timeout')); } catch {} }, timeoutMs);
  try {
    for await (const chunk of req) {
      bytes += chunk.length;
      if (bytes > limitBytes) throw new Error('request body too large');
      chunks.push(chunk);
    }
  } finally {
    clearTimeout(to);
  }
  return Buffer.concat(chunks).toString('utf8');
}

// Race a promise against a timeout; onTimeout() builds the fallback value.
function withTimeout(promise, ms, onTimeout) {
  let timer;
  const timeout = new Promise((resolve) => {
    timer = setTimeout(() => {
      try { resolve(onTimeout()); }
      catch (e) { resolve({ error: e instanceof Error ? e : new Error(String(e)), timedOut: true }); }
    }, ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

// Never leak stacks, local paths, or internals to the caller.
function sanitizeError(raw) {
  if (!raw) return 'Error';
  let s = String(raw).trim();
  const low = s.toLowerCase();
  if (/err_tunnel|err_proxy|tunnel/i.test(s)) return 'proxy connection failed';
  if (/err_connection_reset/i.test(s)) return 'connection reset';
  if (/err_connection_timed_out|err_timed_out/i.test(s)) return 'connection timeout';
  if (/err_name_not_resolved|no such host/i.test(s)) return 'DNS resolution failed';
  if (/timeout/i.test(low)) return 'timeout';
  if (/target closed|browser has been closed|protocol error/i.test(s)) return 'browser closed';
  if (/execution context was destroyed/i.test(s)) return 'page navigation interrupted';
  if (/cannot read propert/i.test(s)) return 'kasada arming failed';
  if (/kpsdk never armed/i.test(s)) return 'kasada arming failed';
  s = s.replace(/[A-Z]:\\[^\s'"]+/gi, '<path>');
  s = s.replace(/\/(?:home|tmp|var|mnt)\/[^\s'"]+/g, '<path>');
  s = s.replace(/\b(pup(?:peteer)|play(?:wright)|chromium|chrome|webkit|cdp|devtools|webdriver|node_modules|pptr:)\b/gi, ''); // scrub-list: strip automation-fingerprint words from API-facing errors; (?:...) splits are non-capturing, matching is unchanged
  s = s.replace(/:\d+:\d+\)?/g, ''); // line:col suffixes
  s = s.replace(/\s+/g, ' ').trim();
  if (s.length === 0) return 'Error';
  if (s.length > 200) s = s.slice(0, 197) + '...';
  return s;
}

async function closeQuietly(target, ms = 5000) {
  if (!target) return;
  try {
    await Promise.race([Promise.resolve(target.close()), new Promise((r) => setTimeout(r, ms).unref?.())]);
  } catch { /* discarding anyway */ }
}

// ---------------------------------------------------------------------------
// Handlers
// ---------------------------------------------------------------------------
async function handleToken(req, res) {
  if (shuttingDown) return send(res, 503, { ok: false, error: 'shutting down', stage: 'lifecycle' });
  if (stats.requestsActive >= MAX_CONCURRENT) {
    stats.requestsRejectedBusy++;
    res.setHeader('retry-after', '5');
    return send(res, 429, { ok: false, error: `busy (${stats.requestsActive}/${MAX_CONCURRENT} mints in flight)`, stage: 'gate' });
  }
  // lazy browser: the first request pays the Chrome launch (memoized; concurrent callers share it)
  try { await ensureBrowser(); } catch (e) {
    return send(res, 503, { ok: false, error: `browser failed to launch: ${sanitizeError(e?.message || e)}`, stage: 'browser' });
  }
  // re-check after the await (a cold-launch burst could all have passed the pre-launch gate)
  if (stats.requestsActive >= MAX_CONCURRENT) {
    stats.requestsRejectedBusy++;
    return send(res, 429, { ok: false, error: `busy (${stats.requestsActive}/${MAX_CONCURRENT} mints in flight)`, stage: 'gate' });
  }

  let body;
  try {
    const raw = await readBody(req);
    body = raw ? JSON.parse(raw) : {};
  } catch (e) {
    return send(res, 400, { ok: false, error: `invalid JSON body: ${String(e?.message || e).slice(0, 120)}`, stage: 'request' });
  }

  const url = typeof body.url === 'string' ? body.url.trim() : '';
  if (!url) return send(res, 400, { ok: false, error: 'url is required (the Kasada-protected page origin), e.g. "https://protected.example.com"', stage: 'request' });
  const endpointPath = typeof body.endpointPath === 'string' ? body.endpointPath : '';
  if (!endpointPath.startsWith('/')) {
    return send(res, 400, { ok: false, error: 'endpointPath is required and must start with "/" (x-kpsdk-ct is bound to the protected request path), e.g. "/login/path"', stage: 'request' });
  }

  let target;
  try {
    target = resolveTarget({ url, endpoint: { path: endpointPath } });
  } catch (e) {
    return send(res, 400, { ok: false, error: sanitizeError(e?.message || e), stage: 'request' });
  }

  let proxy = null;
  if (body.proxy) {
    proxy = parseProxy(String(body.proxy));
    if (!proxy?.host) {
      return send(res, 400, { ok: false, error: 'invalid proxy - expected "http://[user:pass@]host:port" (also accepts socks5/https schemes and bare host:port forms)', stage: 'request' });
    }
  }
  const userAgent = typeof body.userAgent === 'string' && body.userAgent.trim() ? body.userAgent.trim() : null;

  // atomic gate right before the increment (no await in between)
  if (stats.requestsActive >= MAX_CONCURRENT) { stats.requestsRejectedBusy++; return send(res, 429, { ok: false, error: `busy (${stats.requestsActive}/${MAX_CONCURRENT} mints in flight)`, stage: 'gate' }); }
  stats.requestsTotal++;
  stats.requestsActive++;
  const reqId = stats.requestsTotal;
  const t0 = Date.now();
  log('TOKEN', `#${reqId} mint ${target.origin}${endpointPath} proxy=${proxy ? proxy.host : 'none'} ua=${userAgent ? 'custom' : 'default'}`);

  let context, page;
  try {
    const ctxOpts = proxy ? { proxyServer: proxyServerUrl(proxy) } : {};
    context = await browser.createBrowserContext(ctxOpts);
    page = await context.newPage();
    await minimizeWindow(page); // shove the new window to the taskbar (focus-steal mitigation)
    if (proxy?.user) {
      await page.authenticate({ username: proxy.user, password: proxy.pass || '' }).catch(() => {});
    }
    if (userAgent) {
      await page.setUserAgent(userAgent).catch(() => {});
    }

    const result = await withTimeout(
      (async () => {
        let armTarget = target;
        if (!armTarget.pjsUrl) {
          // first mint for this origin: discover the Kasada script URL in a throwaway
          // context, then cache it per-origin (later mints skip discovery)
          const dctx = await browser.createBrowserContext(ctxOpts);
          let pjs = null;
          let dpage = null;
          try {
            dpage = await dctx.newPage();
            await minimizeWindow(dpage);
            if (proxy?.user) {
              await dpage.authenticate({ username: proxy.user, password: proxy.pass || '' }).catch(() => {});
            }
            pjs = await detectPjsUrl(dpage, target);
          } finally {
            await dpage?.close().catch(() => {}); // close the page first so its CDPSession detaches
            await dctx.close().catch(() => {});
          }
          if (!pjs) {
            return { ok: false, error: 'could not auto-detect the Kasada script (p.js) for this site - is this URL actually Kasada-protected?' };
          }
          cachePjsUrl(target.origin, pjs);
          armTarget = { ...target, pjsUrl: pjs };
        }
        const armed = await runSemiVm(page, { skipLogin: true, target: armTarget, label: `tok${reqId}` });
        if (!armed.sdkReady?.ok) {
          return { ok: false, error: armed.error?.message || 'kasada arm failed' };
        }
        return await mintTokens(page, { target: armTarget, egressIp: true });
      })(),
      SESSION_TIMEOUT_MS,
      () => ({ ok: false, error: `timeout ${SESSION_TIMEOUT_MS}ms`, timedOut: true }),
    );

    const elapsedMs = Date.now() - t0;
    if (!result.ok) {
      stats.requestsFailed++;
      log('TOKEN', `#${reqId} FAIL (${elapsedMs}ms): ${result.error}`);
      return send(res, result.timedOut ? 504 : 502, {
        ok: false,
        error: sanitizeError(result.error),
        stage: result.timedOut ? 'timeout' : 'mint',
        elapsedMs,
      });
    }

    stats.requestsPassed++;
    noteKpsdkVersion(result.headers?.['x-kpsdk-v']);
    log('TOKEN', `#${reqId} OK ct=${result.headers['x-kpsdk-ct']?.slice(0, 14)}... v=${result.headers['x-kpsdk-v']} (${elapsedMs}ms)`);
    return send(res, 200, {
      ok: true,
      ct: result.headers['x-kpsdk-ct'],
      cd: result.headers['x-kpsdk-cd'],
      h: result.headers['x-kpsdk-h'],
      v: result.headers['x-kpsdk-v'],
      cookies: result.cookies,
      cookieHeader: result.cookieHeader,
      userAgent: result.userAgent,
      egressIp: result.egressIp ?? null,
      expiresAt: Date.now() + 30 * 60 * 1000, // x-kpsdk-ct lives ~30 min
      elapsedMs,
    });
  } catch (e) {
    stats.requestsFailed++;
    log('ERR', `#${reqId} token error: ${e?.message || e}`);
    return send(res, 500, { ok: false, error: sanitizeError(e?.message || e), stage: 'internal' });
  } finally {
    stats.requestsActive--;
    try {
      if (page && !page.isClosed()) await page.close();
      if (context) await context.close();
    } catch { /* discarding anyway */ }
  }
}

async function handleHealth(req, res) {
  const out = {
    ok: !shuttingDown,
    uptime: Math.round((Date.now() - stats.startedAt) / 1000),
    chromeUp: !!browser?.connected,
    mints: { total: stats.requestsTotal, passed: stats.requestsPassed, failed: stats.requestsFailed, busy: stats.requestsRejectedBusy, active: stats.requestsActive, maxConcurrent: MAX_CONCURRENT },
  };
  if (_kpsdkVersion) out.kpsdkVersion = _kpsdkVersion;
  send(res, 200, out);
}

async function handleShutdown(req, res) {
  if (shuttingDown) return send(res, 409, { ok: false, error: 'already shutting down', stage: 'lifecycle' });
  shuttingDown = true;
  log('STOP', 'shutdown via API');
  send(res, 200, { ok: true, message: 'shutting down' });
  const forceExit = setTimeout(() => process.exit(0), 10_000);
  forceExit.unref?.();
  setTimeout(async () => {
    try { if (browser) await browser.close(); } catch { /* ignore */ }
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 3000).unref?.();
  }, 200);
}

// ---------------------------------------------------------------------------
// Server
// ---------------------------------------------------------------------------
const server = http.createServer(async (req, res) => {
  res.setHeader('access-control-allow-origin', '*');
  res.setHeader('access-control-allow-headers', 'content-type');
  if (req.method === 'OPTIONS') return send(res, 204, '');

  try {
    if (req.method === 'GET' && req.url === '/health') return handleHealth(req, res);
    if (req.method === 'POST' && req.url === '/token') return handleToken(req, res);
    if (req.method === 'POST' && req.url === '/shutdown') return handleShutdown(req, res);
    if (req.method === 'GET' && (req.url === '/' || req.url.startsWith('/?'))) {
      return send(res, 200, {
        name: 'kasada-solver',
        description: 'browser-based Kasada token minter (real Chrome over raw CDP)',
        status: shuttingDown ? 'STOPPING' : 'ONLINE',
        endpoints: ['GET /health', 'POST /token', 'POST /shutdown'],
      });
    }
    return send(res, 404, { ok: false, error: 'not found', valid: ['GET /health', 'POST /token', 'POST /shutdown'] });
  } catch (e) {
    send(res, 500, { ok: false, error: sanitizeError(e?.message || e), stage: 'internal' });
  }
});

server.on('error', (err) => {
  log('ERR', `FATAL: server.listen error: ${err?.code || ''} ${err?.message || err}`);
  process.exit(1);
});

server.listen(PORT, () => {
  log('BOOT', `kasada-solver listening on http://127.0.0.1:${PORT} (max concurrent ${MAX_CONCURRENT})`);
  log('BOOT', `chrome: ${CHROME || 'NOT FOUND - set CHROME_BIN'}`);
  if (!DISPLAY.ok) log('ERR', DISPLAY.msg + '\n' + DISPLAY.hint);
});

// ---------------------------------------------------------------------------
// Signals + safety nets
// ---------------------------------------------------------------------------
async function shutdown(signal) {
  if (shuttingDown) return; // already in progress
  shuttingDown = true;
  log('STOP', `received ${signal}, closing browser...`);
  try { if (browser) await browser.close(); } catch { /* ignore */ }
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(1), 5000).unref?.();
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGHUP', () => shutdown('SIGHUP'));
process.on('unhandledRejection', (reason) => {
  log('ERR', `unhandledRejection: ${reason?.message || reason}`);
});
process.on('uncaughtException', (err) => {
  log('ERR', `uncaughtException: ${err?.message || err}`);
});
