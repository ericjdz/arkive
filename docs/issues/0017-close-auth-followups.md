# 0017 — Close the auth follow-ups from 0016

status: done
stream: security
blocked_by: 0003

## Context

0016 put the viewer server behind a per-run bearer token: loopback bind,
`Authorization` required on all `/api/*`, exact-origin CORS, `Host` header
validation, token-gated shutdown. All five verified with before/after evidence
against a live server.

It left two follow-ups. Both are in its own words: *"the first thing I'd do
next."*

### 1. `open_viewer` returns a tokenless URL — a live regression

`src/server/tools.ts:370,384` builds `http://localhost:${port}` and
destructures only `{ server }` from `createViewerServer`. `createViewerServer`
now returns `{ app, server, token }`. **With authentication on, every URL the
MCP `open_viewer` tool hands a user returns 401 on every request.**

This is user-facing and ships broken. It is a regression introduced by 0016,
not pre-existing debt.

0016 worked around part of it by patching the returned `Server` so a
hostless `listen(port)` still binds loopback — that covers the bind, not the
token. The URL is still wrong.

### 2. The auth story lives in a string inside `serve.ts`

Every viewer API call is a bare `fetch("/api/…")` — `src/viewer/src/api/architecture.ts:65`,
`api/prompts.ts:20,31,44`, `api/learning.ts:20,28`, `App.tsx:125`. None of
them send a header.

Requiring `Authorization` alone would have 401'd every panel and shipped a
fully broken product with passing tests. So the server injects
`buildViewerBootstrapScript` into the served HTML: it reads the URL fragment,
`history.replaceState`s it out of the address bar, and wraps `window.fetch` to
attach the header to same-origin requests only.

It works. It is tested. It is also a monkey-patch of a global, and it means the
viewer's authentication lives in a template string in a different file from the
viewer. `buildViewerBootstrapScript` is one self-contained exported function
precisely so this can be deleted.

## Scope

1. **`open_viewer` carries the token.** Pull `token` off the handle, build the
   URL through `viewerUrl(port, token)` (already exported at `serve.ts:114`),
   return it in the tool response. Test that a URL from `open_viewer` renders
   a working viewer.
2. **Viewer owns its header.** In `src/viewer/src/api/`, read the fragment once
   in a shared module, attach `Authorization` to same-origin API calls
   directly. ~10 lines.
3. **Delete the bridge.** Remove `buildViewerBootstrapScript`, its injection
   point at `serve.ts:166-168`, and the HTML rewrite. Nothing else may depend
   on it.
4. **Keep the frictionless flow intact.** `arkive serve` → browser opens →
   everything renders, with nothing copied. Test the end-to-end path, not just
   the API unit.

## Acceptance criteria

- [x] A viewer URL produced by the MCP `open_viewer` tool renders a working
      viewer, authenticated. Verified against a real MCP server over stdio: the
      returned URL's token returns 200, and the same URL without the token
      returns 401.
- [x] No `fetch` monkey-patch remains anywhere in the codebase. Verified by
      grep over `src/` for `window.fetch =` and `globalThis.fetch =`: no matches.
      The served HTML from a real run contains no injected script.
- [x] `buildViewerBootstrapScript` and its injection are deleted. 57 lines
      removed from `serve.ts`.
- [x] The fragment is stripped from the address bar on load. Verified in a real
      headless browser: address bar reads `http://localhost:PORT/` after load.
- [x] Manual URL entry still works when the token is present, and 401s clearly
      when it is not. Verified in a real browser: a hand-typed URL with session
      memory cleared renders an explicit "401 Unauthorized" error, not a blank
      page and not a silent fallback.
- [x] `npm run lint` and `npm test` pass.

### Deviation: two of 0016's 23 cases were removed, with cause

`tests/cli/serve-security.test.ts` went from 23 cases to 21. Both removals
asserted the mechanism this issue deletes, not the behaviour:

- `"injects the bootstrap script into the viewer document"` called
  `injectBootstrap(html, token)`. The function no longer exists; there is
  nothing to inject.
- `"attaches the bearer header to same-origin API calls, and only those"`
  executed the injected script via `new Function` against a fake `window`.

The behaviour moved, it did not weaken. `tests/viewer/api-auth.test.ts`
asserts it against the real viewer code: a same-origin call gets
`Bearer <token from the fragment>`, a call to `https://evil.example` gets no
header at all. All 21 remaining boundary cases are unmodified — bare-URL 401,
wrong token, non-bearer scheme, cross-origin 403, preflight 403, exact origin,
no-wildcard, Host validation, rebound Host, shutdown 401/403, DELETE 401, and
"401s every /api route".

### Deviation: the token goes into `sessionStorage`

Not in the original scope, and necessary. Stripping the fragment is an
acceptance criterion, but once the bridge is gone the server no longer
re-injects a copy into every HTML response — so stripping the fragment would
make F5 permanently break the viewer. `sessionStorage` is per-origin and
per-tab, so a hostile page cannot read it, and the server still requires the
token on every `/api/*`.

Cost: the token dies with the tab or with a site-data clear, and you re-open
the URL `serve` / `open_viewer` printed.

## Follow-ups raised during implementation

1. **`open_viewer`'s `alreadyRunning` branch is module state.** If the MCP
   server restarts while the viewer keeps running, the tool forgets the token
   and the live server becomes unreachable. Pre-existing, but the same shape as
   the bug this issue fixed, and now more visible because the URL depends on
   the token. Needs a health endpoint that returns the current token, or a
   pidfile.
2. **`arkive stop`** must be checked against the token-gated `/api/shutdown`.
3. **Consider a TTL or a visible indicator** in the viewer header. The token is
   now long-lived for the tab rather than per-request.

## Do not regress

0016's honest cost report, which remains true and should stay true: hand-typing
`localhost:4567` without the token now 401s where it used to work. That is the
correct trade. Do not quietly reintroduce an unauthenticated path to make the
UX smoother — if the friction is unacceptable, solve it in the URL flow, not by
weakening the boundary.