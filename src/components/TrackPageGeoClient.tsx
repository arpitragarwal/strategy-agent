"use client";

import { track } from "@vercel/analytics";
import { usePathname } from "next/navigation";
import { useEffect } from "react";

type Props = {
  /** Only set when present on the edge request; omitted when unknown. */
  country?: string;
  region?: string;
  city?: string;
  postal?: string;
};

/**
 * Fires a `pageview_geo` custom event from the browser on every client-side
 * route change (plus the initial render), tagged with the visitor geo that
 * the server component resolved from Vercel's edge headers.
 *
 * Why client-side: the server-side `track()` in the original implementation
 * picked up Vercel's own internal traffic (dashboard previews, OG-image bots,
 * build-time prerenders), which all originate from one datacenter and
 * collapsed every geo property to a single value. Browser-originated events
 * are only emitted for real visitors and follow the SPA's navigation, so the
 * per-property breakdown now mirrors the built-in Countries panel.
 */
export default function TrackPageGeoClient({
  country,
  region,
  city,
  postal,
}: Props) {
  const pathname = usePathname();

  useEffect(() => {
    const props: Record<string, string> = { pathname: pathname ?? "/" };
    if (country) props.country = country;
    if (region) props.region = region;
    if (city) props.city = city;
    if (postal) props.postal = postal;
    try {
      track("pageview_geo", props);
    } catch {
      // Analytics must never break rendering. Swallow.
    }
  }, [pathname, country, region, city, postal]);

  return null;
}
