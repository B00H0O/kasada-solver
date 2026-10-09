const _PJS_CACHE = new Map();
export function cachePjsUrl(origin, pjsUrl) {
  if (origin && pjsUrl) _PJS_CACHE.set(origin, pjsUrl);
}
export function getCachedPjsUrl(origin) {
  return (origin && _PJS_CACHE.get(origin)) || null;
}

function reEscape(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export function endpointReFor(target) {
  return new RegExp(reEscape(target.endpoint.path), 'i');
}

function normPjs(origin, pjsUrl, pjsPath) {
  if (pjsUrl) return pjsUrl;
  if (pjsPath) return origin + (pjsPath.startsWith('/') ? pjsPath : '/' + pjsPath);
  return null;
}

export function isResolvedTarget(x) {
  return !!(x && x.origin && x.endpoint && x.endpoint.path);
}

export function resolveTarget(input = {}) {
  if (isResolvedTarget(input)) {
    if (!input.pjsUrl) {
      const cached = getCachedPjsUrl(input.origin);
      if (cached) return { ...input, pjsUrl: cached };
    }
    return input;
  }

  const raw = input.url || input.origin;
  if (!raw) {
    throw new Error(
      'resolveTarget: pass a resolved target (from a checker) or { url, endpoint:{ method, path } }'
    );
  }
  let u;
  try {
    u = new URL(raw);
  } catch {
    throw new Error(`resolveTarget: invalid url "${raw}"`);
  }
  const ep = input.endpoint || {};
  if (!ep.path) {
    throw new Error(
      'resolveTarget: endpoint.path is required for a generic site ' +
        '(the protected request path the Kasada tokens are minted for, e.g. "/api/login")'
    );
  }
  return {
    name: input.name || input.site || u.host,
    url: input.url || u.origin + '/',
    origin: u.origin,
    host: u.host,
    pjsUrl: normPjs(u.origin, input.pjsUrl, input.pjsPath) || getCachedPjsUrl(u.origin),
    endpoint: {
      domain: ep.domain || u.host,
      method: String(ep.method || 'POST').toUpperCase(),
      path: ep.path,
      protocol: ep.protocol || u.protocol || 'https:',
    },
    loginBody: input.loginBody || null,
  };
}
