import { headers } from "next/headers";
import { track } from "@vercel/analytics/server";

/**
 * Server component that fires a single `pageview_geo` custom event per server
 * render, tagged with the visitor's city/region/country/postal code derived
 * from Vercel's edge geo headers. Renders nothing.
 *
 * Why a separate component instead of inlining in `layout.tsx`:
 *  - Calling `headers()` opts a render into dynamic mode. Keeping the call
 *    inside this leaf component scopes that to just this subtree.
 *  - Easier to no-op safely (try/catch around `track`) without affecting the
 *    rest of the layout if the analytics endpoint is unreachable.
 *
 * Caveats:
 *  - Geo headers are populated by the Vercel edge in production. In `next dev`
 *    they're missing; values fall back to "unknown".
 *  - This fires on full server renders only; client-side navigations within
 *    the SPA are tracked by the standard <Analytics /> pageview, not here.
 */
export default async function TrackPageGeo() {
  try {
    const h = await headers();
    const country = h.get("x-vercel-ip-country") ?? "unknown";
    const region = h.get("x-vercel-ip-country-region") ?? "unknown";
    const cityRaw = h.get("x-vercel-ip-city");
    const city = cityRaw ? safeDecode(cityRaw) : "unknown";
    const postal = h.get("x-vercel-ip-postal-code") ?? "unknown";

    await track("pageview_geo", { country, region, city, postal });
  } catch {
    // Analytics must never break a render. Swallow.
  }

  return null;
}

function safeDecode(s: string): string {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
}
