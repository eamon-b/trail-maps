/**
 * Vite's compile-time environment, as the web pages use it.
 *
 * Only `VITE_*` names reach the browser bundle (Vite's default `envPrefix`),
 * and every one of them is public: it is inlined into the JavaScript the site
 * ships, so nothing secret may ever be added here.
 *
 * `VITE_API_BASE_URL` is the comments/plans API origin
 * (`https://api.contour-map-tiles.net`, or a local `wrangler dev` server).
 * Leaving it unset is a supported configuration: the planner then keeps plans
 * in `localStorage` alone and hides the Sync and Share buttons entirely.
 */

interface ImportMetaEnv {
  readonly VITE_API_BASE_URL?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
