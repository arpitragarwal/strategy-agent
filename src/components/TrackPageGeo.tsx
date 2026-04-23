import { headers } from "next/headers";
import TrackPageGeoClient from "./TrackPageGeoClient";

/**
 * Server component that resolves the visitor's geo from Vercel's edge headers
 * and hands the values to a client-side tracker. Renders nothing visible.
 *
 * Design notes:
 *  - Tracking itself now happens in the browser (see `TrackPageGeoClient`) so
 *    the event is attributed to the real visitor and fires on client-side
 *    navigations. We still read the headers here because browser JS cannot
 *    resolve the viewer's precise geo — only the edge can.
 *  - Calling `headers()` opts this subtree into dynamic rendering. That's the
 *    point: we need the request-scoped edge headers on every real visit.
 *  - Missing headers are passed through as `undefined` so the client tracker
 *    omits the property entirely rather than reporting a noisy `"unknown"`
 *    bucket in the Vercel Analytics dashboard.
 */
export default async function TrackPageGeo() {
  try {
    const h = await headers();
    const country = nonEmpty(h.get("x-vercel-ip-country"));
    const region = nonEmpty(h.get("x-vercel-ip-country-region"));
    const cityRaw = h.get("x-vercel-ip-city");
    const city = cityRaw ? safeDecode(cityRaw) : undefined;
    const postal = nonEmpty(h.get("x-vercel-ip-postal-code"));

    return (
      <TrackPageGeoClient
        country={country}
        region={region}
        city={city}
        postal={postal}
      />
    );
  } catch {
    return null;
  }
}

function nonEmpty(v: string | null): string | undefined {
  if (!v) return undefined;
  const t = v.trim();
  return t.length > 0 ? t : undefined;
}

function safeDecode(s: string): string | undefined {
  const raw = s.trim();
  if (!raw) return undefined;
  try {
    return decodeURIComponent(raw);
  } catch {
    return raw;
  }
}
