# 0018 — Viewer build hygiene

status: open
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

## Acceptance criteria

- [ ] `npm run build` twice in a row produces an identical `dist/viewer` with no
      stray declarations.
- [ ] A dev server can talk to the viewer API, via an explicit dev-only origin
      allowance.
- [ ] Neither change weakens 0016's production boundary.