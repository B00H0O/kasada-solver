// lib.mjs — the small shared subset the solver closure needs: Kasada URL regexes,
// proxy parsing, and Chrome discovery. No env files, no proxy files, no provider
// names — a public, target-agnostic service takes everything per request.

import fs from 'node:fs';
import path from 'node:path';

export const PJS_RE = /\/p\.js(?:\?|$)/;
export const MFC_RE = /\/mfc(?:\?|$)/;
export const TL_RE = /\/tl(?:\?|$)/;
export const FP_RE = /\/fp(?:\?|$)/;

export function findChrome() {
  const env = process.env.CHROME_BIN;
  if (env && fs.existsSync(env)) return env;

  if (process.platform === 'linux') {
    const linuxCandidates = [
      '/usr/bin/google-chrome',
      '/usr/bin/google-chrome-stable',
      '/usr/bin/chromium',
      '/usr/bin/chromium-browser',
      '/snap/bin/chromium',
      '/opt/google/chrome/chrome',
      '/usr/local/bin/google-chrome',
      '/usr/local/bin/chromium',
    ];
    return linuxCandidates.find((p) => fs.existsSync(p)) || null;
  }

  if (process.platform === 'darwin') {
    const macCandidates = [
      '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
      '/Applications/Chromium.app/Contents/MacOS/Chromium',
    ];
    return macCandidates.find((p) => fs.existsSync(p)) || null;
  }

  const winCandidates = [
    path.join(process.env['ProgramFiles'] || 'C:\\Program Files', 'Google', 'Chrome', 'Application', 'chrome.exe'),
    path.join(process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)', 'Google', 'Chrome', 'Application', 'chrome.exe'),
    path.join(process.env['LOCALAPPDATA'] || '', 'Google', 'Chrome', 'Application', 'chrome.exe'),
  ];
  return winCandidates.find((p) => p && fs.existsSync(p)) || null;
}

export function checkDisplay() {
  if (process.platform !== 'linux') return { ok: true };
  if (process.env.DISPLAY || process.env.WAYLAND_DISPLAY) {
    return { ok: true, source: process.env.DISPLAY || 'wayland' };
  }
  return {
    ok: false,
    msg: 'Linux: no DISPLAY or WAYLAND_DISPLAY env var. Headed Chrome (mandatory for Kasada) needs a display.',
    hint:
      'Install Xvfb and run via xvfb-run, e.g.:\n' +
      '  sudo apt install -y xvfb google-chrome-stable\n' +
      '  xvfb-run -a --server-args="-screen 0 1280x720x24" node server.mjs\n' +
      'Or set DISPLAY=:99 and start Xvfb manually:\n' +
      '  Xvfb :99 -screen 0 1280x720x24 &\n' +
      '  DISPLAY=:99 node server.mjs',
  };
}

const _isPort = (s) => /^\d{1,5}$/.test(s) && Number(s) >= 1 && Number(s) <= 65535;
function _defaultPort(type) { return type === 'https' ? '443' : type === 'socks5' || type === 'socks4' ? '1080' : '80'; }

export function parseProxy(raw) {
  if (!raw?.trim()) return null;
  let t = raw.trim();
  let type = 'http';
  const sm = t.match(/^([a-z][a-z0-9+.-]*):\/\//i);
  if (sm) {
    const s = sm[1].toLowerCase();
    if (s.startsWith('socks5') || s === 'socks') type = 'socks5';
    else if (s.startsWith('socks4')) type = 'socks4';
    else if (s === 'https') type = 'https';
    else type = 'http';
    try {
      const u = new URL(t);
      if (u.hostname) {
        return {
          type,
          host: u.hostname,
          port: u.port || _defaultPort(type),
          user: u.username ? decodeURIComponent(u.username) : undefined,
          pass: u.password ? decodeURIComponent(u.password) : '',
        };
      }
    } catch { /* malformed - strip scheme and fall through to bare parsing */ }
    t = t.slice(sm[0].length);
  }
  if (t.includes('@')) {
    const at = t.lastIndexOf('@');
    const left = t.slice(0, at);
    const right = t.slice(at + 1);
    const rp = right.split(':');
    const lp = left.split(':');
    let addr, auth;
    if (rp.length >= 2 && _isPort(rp[1])) { addr = right; auth = left; }       // user:pass@host:port
    else if (lp.length >= 2 && _isPort(lp[1])) { addr = left; auth = right; }  // host:port@user:pass
    else { addr = right; auth = left; }                                        // default: addr after @
    const [host, port] = addr.split(':');
    const ci = auth.indexOf(':');
    const user = ci >= 0 ? auth.slice(0, ci) : auth;
    const pass = ci >= 0 ? auth.slice(ci + 1) : '';
    return { type, host, port: port || _defaultPort(type), user: user || undefined, pass };
  }
  const p = t.split(':');
  if (p.length === 2) return { type, host: p[0], port: _isPort(p[1]) ? p[1] : _defaultPort(type), user: undefined, pass: '' };
  if (p.length >= 4) {
    // when BOTH p[1] and p[3] look like ports (e.g. a NUMERIC password:
    // `user:8080:host.com:1080`), disambiguate on which field looks like a host
    // (has a dot) - usernames rarely do.
    const port1 = _isPort(p[1]);
    const port3 = _isPort(p[3]);
    const looksHost = (s) => s.includes('.');
    if (port1 && port3) {
      if (looksHost(p[2]) && !looksHost(p[0])) return { type, host: p[2], port: p[3], user: p[0] || undefined, pass: p[1] }; // user:pass:host:port
      return { type, host: p[0], port: p[1], user: p[2] || undefined, pass: p.slice(3).join(':') };                          // host:port:user:pass
    }
    if (port1) return { type, host: p[0], port: p[1], user: p[2] || undefined, pass: p.slice(3).join(':') }; // host:port:user:pass
    if (port3) return { type, host: p[2], port: p[3], user: p[0] || undefined, pass: p[1] };                 // user:pass:host:port
    return { type, host: p[0], port: p[1], user: p[2] || undefined, pass: p.slice(3).join(':') };            // ambiguous -> host-first
  }
  if (p.length === 3) return { type, host: p[0], port: _isPort(p[1]) ? p[1] : _defaultPort(type), user: p[2] || undefined, pass: '' }; // host:port:user
  return { type, host: p[0], port: _defaultPort(type), user: undefined, pass: '' };               // host only
}

export function proxyServerUrl(proxy) {
  if (!proxy?.host) return null;
  const type = proxy.type || 'http';
  return `${type}://${proxy.host}:${proxy.port}`;
}
