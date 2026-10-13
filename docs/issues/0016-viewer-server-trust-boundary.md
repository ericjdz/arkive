# 0016 — Viewer server trust boundary

status: done
stream: security
blocked_by: 0001

## Context

Flagged by the ADR-0006 author, which correctly declined to scope it: this is a
security decision, not a data-integrity one, and it deserves its own record.

`src/cli/commands/serve.ts` exposes an HTTP server with no authentication, a
permissive CORS policy, and a non-loopback bind. All three verified by reading
the source:

- `serve.ts:25` — `Access-Control-Allow-Origin: *`
- `serve.ts:26` — `Access-Control-Allow-Methods: GET, POST, DELETE, OPTIONS`
- `serve.ts:160` — `server.listen(port)` with no host argument, binding
  `0.0.0.0` / `::` rather than loopback

`learn.ts` starts the same server, so Learning Mode inherits every one of these.

## Exposure

Any web page the developer visits **while `arkive serve` is running** can reach
this server. The developer runs it to view their architecture and then browses
the web in the same browser session — this is the normal usage pattern, not an
edge case.

- `GET /api/architecture` (`serve.ts:101`) is a simple request, so it skips
  preflight, and `ACAO: *` makes the response readable by attacker JavaScript.
  Full architecture exfiltration: connection topology, decision rationales,
  internal service names.
- `POST /api/prompts` writes into the queue that a connected agent later
  **claims and executes** (`claim_next_prompt` → the agent runs the prompt).
  That is an unauthenticated write into an execution path.
- `DELETE /api/prompts/:id` is in `Allow-Methods`, passes preflight under
  `ACAO: *`, and can destroy the user's queued work.
- `POST /api/shutdown` (`serve.ts:132`) ignores the body, so a `no-cors` POST
  with no body succeeds — any site can kill the server process.

DNS rebinding is also unguarded: there is no `Host` header check.

## Scope

1. **Bind loopback only.** `server.listen(port, "127.0.0.1")` in both `serve.ts`
   and `learn.ts`. A developer has no reason to expose their architecture
   document to their LAN.
2. **Per-run bearer token.** Generate `randomBytes(24)` at startup, hand it to
   the viewer through the URL fragment (never a query param — those land in
   logs), require `Authorization: Bearer` on all `/api/*`.
3. **Exact-origin CORS.** Replace `*` with the specific origin the viewer is
   served from.
4. **`Host` header check.** Reject non-`localhost` values. Blocks DNS rebinding,
   which survives the token if the attacker can guess or observe it.
5. **`/api/shutdown` requires the token** and is not reachable cross-origin.

## Interaction with 0010

If ADR-0004 lands option (c) — dropping the viewer — this issue evaporates with
the server. If options (a) or (b) land, this is mandatory and ships first. Do
not ship any viewer variant with the current server code.

## Acceptance criteria

- [ ] Server binds `127.0.0.1`. Verified by attempting a connection on a
      non-loopback interface.
- [ ] Unauthenticated `GET /api/architecture` returns 401.
- [ ] A cross-origin `POST /api/prompts` from an arbitrary origin is rejected.
- [ ] A request with a non-localhost `Host` header is rejected.
- [ ] `POST /api/shutdown` without a token is rejected.
- [ ] Tests cover each of the five.

## Severity note

This is the highest-severity finding in the entire assessment, and it is a
few-line fix. The reason it survived is that nobody who ran `arkive serve` on a
laptop ever thought to test it against a hostile page. That is a process gap,
not a code gap — which is why the answer is CI and a test, not vigilance.