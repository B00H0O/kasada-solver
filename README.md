# Kasada Solver

Kasada solver in Node.js that mints and returns the `x-kpsdk` header set (ct, cd, h, v) plus
cookies, over raw CDP using real Chrome; each mint runs in its own isolated browser context.
Works on any protected URL you supply.

Cookies and headers are ready for replay from the same exit. Not a general browser API.

## Mint a token

```
$ curl -X POST http://localhost:8787/token \
    -H "Content-Type: application/json" \
    -d '{"url":"https://protected.example.com","endpointPath":"/login"}'
{
  "ok": true,
  "ct": "07SWNevLMJG2yY...",
  "cd": "FePr...",
  "h": "...",
  "v": "j-1.2.864",
  "cookies": [{"name":"...","value":"..."}],
  "cookieHeader": "name=value; ...",
  "userAgent": "Mozilla/5.0 ...",
  "egressIp": "203.0.113.10",
  "expiresAt": 1760000000000,
  "elapsedMs": 3242
}
```

PowerShell:

```
PS> curl.exe -X POST http://localhost:8787/token -H "Content-Type: application/json" -d "{\"url\":\"https://protected.example.com\",\"endpointPath\":\"/login\"}"
```

## Run

Docker:

```
$ docker compose up -d --build
$ curl http://localhost:8787/health
{"ok":true,"uptime":8,"chromeUp":false,"mints":{"total":0,"passed":0,"failed":0,"busy":0,"active":0,"maxConcurrent":2}}
```

`chromeUp` stays false until the first mint lazily boots Chrome.

Native, Linux. Needs Chrome/Chromium (auto-detected, or set CHROME_BIN) and Node 20+. Chrome
runs headed, so give it a display:

```
$ npm install
$ xvfb-run -a --server-args="-screen 0 1280x720x24" node server.mjs
```

Native, Windows:

```
PS> .\launch.ps1
```

## API

### POST /token

| Field | Required | Description |
|-------|----------|-------------|
| url | yes | the Kasada-protected page origin |
| endpointPath | yes | the protected request path the token is minted for; `ct` is bound to it |
| proxy | no | per-request proxy for the minting context, any string form listed under Proxy below |
| userAgent | no | override the mint context's user agent |

Response fields:

- `ct` / `cd` / `h` / `v` - the `x-kpsdk-ct`, `x-kpsdk-cd`, `x-kpsdk-h`, `x-kpsdk-v` request
  headers; `v` is the Kasada build
- `cookies` + `cookieHeader` - ready-made replay cookie jar
- `userAgent` - the mint context's UA; replay it with the token
- `egressIp` - the exit IP the mint went out on
- `expiresAt` - mint time + 30 min (`x-kpsdk-ct` lives about that long)
- `elapsedMs` - wall time of the mint
- errors: 400 bad url/endpointPath or proxy JSON, 429 busy (MAX_CONCURRENT mints in flight),
  5xx mint or browser failure (per-mint hard cap 90s) - all as `{"ok":false,"error":"...","stage":"..."}`

### GET /health

`mints.total/passed/failed` are lifetime counters; `busy` counts 429 rejections, `active` mints
in flight; `kpsdkVersion` appears once a mint has seen the Kasada build. `chromeUp` is false
until the first mint boots Chrome.

### POST /shutdown

Answers `{"ok":true}`, closes Chrome, exits. A second call gets 409.

### Proxy

Per-request, on /token. String form only - an object form is not accepted.

```
-d '{"url":"https://protected.example.com","endpointPath":"/login","proxy":"http://user:pass@host:8080"}'
```

What the code supports:

- schemes: http (default when omitted), https, socks5 (bare `socks` = socks5), socks4 - handed
  to Chrome's `--proxy-server`
- `scheme://user:pass@host:port` with percent-encoded credentials decoded
- bare forms: `user:pass@host:port`, `host:port`, `host:port:user:pass`, `user:pass:host:port`,
  `host` alone (default port 80/443/1080 by scheme)
- embedded user:pass is answered when the proxy sends an HTTP 407 challenge (http/https);
  Chrome cannot authenticate to SOCKS proxies, so socks schemes work credential-less only

## How it works

Each mint opens a fresh isolated browser context (own cookie jar, own proxy when given) in a
real headed Chrome driven over raw CDP. The first mint for an origin also spends a throwaway
context discovering its Kasada script URL, cached for later mints; the mint page is armed by
stub-serving origin HTML with the Kasada script embedded, the protected request is fired
in-page, and the `x-kpsdk-*` headers are harvested off the paused outgoing request. The
request is aborted before it reaches the protected endpoint, and the context is disposed.

## Settings

Set via environment only - no `.env` file is read.

| Var | Default | Description |
|-----|---------|-------------|
| PORT | 8787 | HTTP port |
| MAX_CONCURRENT | 2 | mints in flight before 429 |
| CHROME_BIN | auto | Chrome/Chromium path (auto-detected) |
| HIDDEN | 1 | offscreen + start-minimized Chrome window (0 = visible); Chrome is always headed |

Rule of thumb: MAX_CONCURRENT at about half your logical cores.

## Scaling

Owner-measured, Oct 2026 (Kasada build j-1.2.864, no proxy):

| Load | Avg | Result |
|------|-----|--------|
| sequential (n=4) | 8.6s cold / 4.4s warm | 4/4 first-try |
| 2 parallel (n=8, 6c/12t box) | 5.2s warm | 20.6 mints/min, 8/8 in 23.3s |

~13 warm mints/min sequential. Concurrency 2 did not double that (5.2s vs 4.4s per mint) -
two headed Chrome contexts contend for one box. **Verdict: single-digit seconds per mint
warm, and parallel throughput scales with cores.**

Raise MAX_CONCURRENT (mints past it get 429) or run more instances on separate ports:

```
$ docker compose up -d --build
$ docker run -d --name solver2 -p 8788:8787 --shm-size 1g kasada-solver
$ docker run -d --name solver3 -p 8789:8787 --shm-size 1g kasada-solver
```

## The ceiling

- Mint-only: returns tokens, does not solve logins or captchas beyond Kasada.
- `ct` is bound to the minting egress IP, User-Agent and cookies. Replay all from the same
  exit or the token is worthless; the per-request proxy is the lever.
- Tokens live roughly 30 minutes (`expiresAt`).
- No built-in auth on the API - do not expose it publicly: anyone who can reach it can mint
  through your IPs.

For authorized security testing and research.

## License

MIT. See LICENSE.
