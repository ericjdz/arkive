/**
 * Viewer-side half of the per-run bearer token handoff.
 *
 * The viewer server requires `Authorization: Bearer <token>` on every `/api/*`
 * request (see docs/issues/0016-viewer-server-trust-boundary.md). The token
 * reaches the browser in the URL **fragment**, which browsers never transmit to
 * a server, so something inside the page has to move it into a header.
 *
 * Until now that something was a script injected into the served HTML by the
 * CLI, which monkey-patched `window.fetch`. That was a bridge. This module is
 * the destination: read the fragment once, remember the token for the tab,
 * strip the fragment from the address bar, and hand the rest of the viewer an
 * `Authorization`-bearing `fetch`.
 *
 * Three rules this module holds to:
 *
 * 1. **Same-origin only.** The header goes on requests that resolve to the
 *    viewer's own origin and on nothing else.
 * 2. **No fallback.** With no token there is no header, and the server's 401
 *    stands. An unauthenticated "same-origin, no token" path is exactly the
 *    hole 0016 closed; reintroducing it to smooth over the UX would reopen it.
 * 3. **Read globals at call time, never at import time.** No module-level side
 *    effects, so importing this module in Node (tests, SSR) is inert and a
 *    viewer served without a token still loads and fails loudly.
 */

/** Per-origin, per-tab storage key. See rule 2 above for why the header is not
 *  attached without a token. */
const STORAGE_KEY = "arkive.viewer.token";

/** `token=…` in a fragment (`#token=x`, `?a=b#token=x&y=z`). */
const FRAGMENT_TOKEN = /(?:^|[#&])token=([^&]+)/;

/**
 * The slice of the browser globals this module touches. Read through a cast
 * rather than through `window` so the module is inert outside a browser and so
 * a test can install a stand-in.
 */
interface ViewerGlobals {
  location?: {
    hash: string;
    href: string;
    origin: string;
    pathname: string;
    search: string;
  };
  history?: { replaceState: (state: unknown, title: string, url?: string) => void };
  sessionStorage?: { getItem(key: string): string | null; setItem(key: string, value: string): void };
}

function globals(): ViewerGlobals | null {
  const g = globalThis as unknown as ViewerGlobals;
  return g.location ? g : null;
}

/** Pull the token out of a fragment string. Pure; exported for tests. */
export function parseFragmentToken(hash: string): string | null {
  if (!hash) return null;
  const match = FRAGMENT_TOKEN.exec(hash);
  if (!match) return null;
  const token = decodeURIComponent(match[1]);
  return token === "" ? null : token;
}

/**
 * The token for this tab, read once.
 *
 * Order: the URL fragment wins (it is the only place the token is ever put in
 * transit), then the per-tab store. The fragment is stripped from the address
 * bar as soon as it is read, so the token does not linger in a screenshot or a
 * copied URL; the store is what makes a reload of the now-fragment-less URL
 * still work. `sessionStorage` is scoped to this origin, so a page on another
 * site cannot read it.
 *
 * Returns null when there is no token. Callers must not treat that as "go on
 * without authentication" — see rule 2.
 */
export function viewerToken(): string | null {
  const g = globals();
  if (!g?.location) return null;

  const fromFragment = parseFragmentToken(g.location.hash);
  if (fromFragment) {
    try {
      g.sessionStorage?.setItem(STORAGE_KEY, fromFragment);
    } catch {
      // Storage disabled (private mode, quota). The fragment is still gone
      // from the address bar, so the token lives for this page view only.
    }
    stripFragment(g, g.location);
    return fromFragment;
  }

  try {
    return g.sessionStorage?.getItem(STORAGE_KEY) ?? null;
  } catch {
    return null;
  }
}

/**
 * Drop the fragment from the address bar, keeping the path and query.
 *
 * Best-effort by design: a fragment left in the address bar is a hygiene
 * problem, not an authentication one, and must not be able to throw the viewer
 * into an error state.
 */
function stripFragment(g: ViewerGlobals, location: NonNullable<ViewerGlobals["location"]>): void {
  if (!location.hash) return;
  try {
    g.history?.replaceState(null, "", location.pathname + location.search);
  } catch {
    // replaceState is best-effort.
  }
}

/**
 * `fetch` for the viewer's own API, carrying the bearer token.
 *
 * Every call the viewer makes is a same-origin `/api/…` path, so this is the
 * single place the header is attached. A cross-origin URL is passed through
 * untouched: the token is for this server only and must not leak to a host the
 * viewer does not own.
 */
export function apiFetch(input: string, init?: RequestInit): Promise<Response> {
  const token = viewerToken();
  const g = globals();
  if (!token || !g?.location) return fetch(input, init);

  let target: URL;
  try {
    target = new URL(input, g.location.href);
  } catch {
    return fetch(input, init);
  }
  if (target.origin !== g.location.origin) return fetch(input, init);

  const headers = new Headers(init?.headers);
  headers.set("Authorization", `Bearer ${token}`);
  return fetch(input, { ...init, headers });
}