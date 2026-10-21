# 0018 — Viewer build hygiene

status: done
stream: view
priority: low
blocked_by: 0010

## Context

Two small build defects found while verifying 0016. Neither is urgent. Both
will bite whoever next touches the viewer, and ADR-0004 needs a working dev
loop before it can evaluate options.

### 1. Declaration output pollutes the viewer's build directory

`tsup.config.ts:13` runs `tsc --emitDeclarationOnly` across all of `src/`,
which includes `src/viewer/`. Those declarations land *inside* the directory
Vite owns:

```
dist/viewer/index.html
dist/viewer/assets/index-*.js
dist/viewer/assets/index-*.css
dist/viewer/src/utils/markdown.d.ts      <- from tsc
dist/viewer/src/utils/mermaid.d.ts      <- from tsc
```

Vite is configured with `emptyOutDir: true`, so whichever build step runs last
determines whether the assets survive. Currently the viewer builds correctly —
`npm run build:viewer` produces a working `dist/viewer/index.html` — but the
two builds are writing into the same directory with no ordering guarantee
between them.

Harmless today. A latent race that will produce a "viewer is missing" bug the
moment the build order changes.

Fix: exclude `src/viewer` from the declaration emit, or emit declarations to a
separate directory.

### 2. Vite dev proxy will be rejected by the origin check

`src/viewer/vite.config.ts` configures `server.proxy`, which forwards requests
with `Origin: http://localhost:5173`. 0016 replaced `Access-Control-Allow-Origin: *`
with an exact-origin check. The proxy's origin is not in the allowlist, so
every dev-mode API call returns 403.

No `dev` script exists yet, so this is latent. It is recorded because the next
person to add `npm run dev` will lose an hour to it.

Fix when the dev loop is needed: add the dev origin to the allowlist behind an
explicit development flag, never unconditionally.

## Closure

Closed as **obsolete**, not as implemented. 0010 chose ADR-0004 option (b): the
React Flow/D3/Vite viewer was deleted and replaced by a build-free, single-file
HTML artifact from `arkive export html`. Both defects were properties of that
build:

- There is no `src/viewer/`, no `tsup` declaration emit into it, and no
  `dist/viewer`. `npm run build` produces no viewer output to race.
- There is no Vite dev server and no `server.proxy`, so the dev-origin
  regression cannot occur. There is no `npm run dev` to repair.

The 0016 trust boundary is unchanged and still verified: the artifact is served
by the same loopback + token-guarded server, and the regression tests that cover
origin checks, token handoff, and the 401 route table remain in
`tests/cli/serve-security.test.ts`.

## Acceptance criteria

- [x] *(obsolete)* `npm run build` twice in a row produces an identical
      `dist/viewer` with no stray declarations. No `dist/viewer` is produced.
- [x] *(obsolete)* A dev server can talk to the viewer API, via an explicit
      dev-only origin allowance. No dev server exists.
- [x] Neither change weakens 0016's production boundary. Verified by the
      retained boundary tests; the server and its allowlist were not changed by
      0010 or 0015.