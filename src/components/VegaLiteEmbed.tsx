"use client";

import { useEffect, useRef } from "react";
import embed from "vega-embed";

export function VegaLiteEmbed({ spec }: { spec: Record<string, unknown> }) {
  const hostRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const el = hostRef.current;
    if (!el) return;

    let cancelled = false;
    let finalize: (() => void) | undefined;

    void embed(el, spec, { actions: false }).then((result) => {
      if (cancelled) {
        result.finalize();
        return;
      }
      finalize = () => result.finalize();
    });

    return () => {
      cancelled = true;
      finalize?.();
    };
  }, [spec]);

  return (
    <div
      ref={hostRef}
      className="w-full max-w-full min-w-0 min-h-[240px] overflow-x-auto [&_svg]:max-w-full"
    />
  );
}
