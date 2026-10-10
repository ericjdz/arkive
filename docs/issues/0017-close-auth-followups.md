# 0017 — Close the auth follow-ups from 0016

status: open
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

- [ ] A viewer URL produced by the MCP `open_viewer` tool renders a working
      viewer, authenticated.
- [ ] No `fetch` monkey-patch remains anywhere in the codebase.
- [ ] `buildViewerBootstrapScript` and its injection are deleted.
- [ ] The fragment is stripped from the address bar on load.
- [ ] Manual URL entry still works when the token is present, and 401s clearly
      when it is not.
- [ ] `npm run lint` and `npm test` pass.

## Do not regress

0016's honest cost report, which remains true and should stay true: hand-typing
`localhost:4567` without the token now 401s where it used to work. That is the
correct trade. Do not quietly reintroduce an unauthenticated path to make the
UX smoother — if the friction is unacceptable, solve it in the URL flow, not by
weakening the boundary.