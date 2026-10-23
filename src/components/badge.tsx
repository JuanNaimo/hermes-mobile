import type { HTMLAttributes } from "react";
import { cn } from "@/lib/utils";

/**
 * The DS badge's non-default tones, copied verbatim. The DS module itself
 * imports its blend-mode/leva tooling for the `default` tone, which would
 * drag several hundred KB of animation libraries into this bundle.
 */
const BASE_CN =
  "inline-flex items-center font-compressed text-display px-2 py-1 leading-none tracking-[0.2em]";
const TONE_CLASSES = {
  destructive: "border border-destructive/30 bg-destructive/15 text-destructive",
  outline: "border border-midground/30 bg-transparent text-midground/80",
  secondary: "border border-midground/15 bg-midground/8 text-midground",
  success: "border border-success/30 bg-success/15 text-success",
  warning: "border border-warning/30 bg-warning/15 text-warning",
};

export function Badge({
  className,
  tone = "outline",
  ...props
}: HTMLAttributes<HTMLSpanElement> & { tone?: keyof typeof TONE_CLASSES }) {
  return <span className={cn(BASE_CN, TONE_CLASSES[tone], className)} {...props} />;
}
