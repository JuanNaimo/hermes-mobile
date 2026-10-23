import { lazy, Suspense } from "react";
import { useApp } from "@/store";
import { findTheme } from "@/themes/presets";
import { cn } from "@/lib/utils";

// ~100 KB of SVG paths: only fetched when a Nous-branded theme is active.
const NousGirlBadge = lazy(() =>
  import("@nous-research/ui/ui/components/badges/nous-girl").then((m) => ({ default: m.NousGirlBadge })),
);

/** The "HERMES / AGENT" lockup; Nous-branded themes add the Nous mascot. */
export function Wordmark({ className, markClassName }: { className?: string; markClassName?: string }) {
  const { settings } = useApp();
  const nous = findTheme(settings.theme).nousBrand;
  return (
    <span className={cn("flex items-center gap-2.5", className)}>
      {nous && (
        <Suspense fallback={null}>
          <NousGirlBadge aria-hidden className={cn("h-9 w-auto shrink-0 text-midground", markClassName)} />
        </Suspense>
      )}
      <span>
        Hermes
        <br />
        Agent
      </span>
    </span>
  );
}
