import { forwardRef, type ButtonHTMLAttributes, type ReactNode } from "react";
import { cn } from "@/lib/utils";

/**
 * Touch-sized primitives in the dashboard's idiom (hairline current/20
 * borders, midground/5 hover wash, uppercase display labels) — the DS
 * components are desktop-sized, so these keep 44px hit targets.
 */

export const IconButton = forwardRef<
  HTMLButtonElement,
  ButtonHTMLAttributes<HTMLButtonElement> & { label: string; active?: boolean }
>(function IconButton({ label, active, className, children, ...props }, ref) {
  return (
    <button
      ref={ref}
      type="button"
      aria-label={label}
      title={label}
      className={cn(
        "relative inline-flex size-11 shrink-0 items-center justify-center",
        "text-text-secondary transition-colors hover:text-midground",
        "hover:bg-midground/5 active:bg-midground/10",
        "focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-midground",
        "disabled:pointer-events-none disabled:opacity-40",
        "[&>svg]:size-5",
        active && "text-midground bg-midground/10",
        className,
      )}
      {...props}
    >
      {children}
    </button>
  );
});

export function SectionLabel({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <span
      className={cn(
        "font-sans text-display text-xs tracking-[0.12em] text-text-tertiary",
        className,
      )}
    >
      {children}
    </span>
  );
}

export function PageTitle({ children, actions }: { children: ReactNode; actions?: ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-3 border-b border-current/20 pb-3">
      <h1 className="font-mondwest text-display text-xl tracking-[0.08em] text-midground sm:text-2xl">
        {children}
      </h1>
      {actions && <div className="flex items-center gap-1">{actions}</div>}
    </div>
  );
}

export function Panel({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <div
      className={cn(
        "border border-current/15 bg-card/60 backdrop-blur-[2px]",
        "rounded-[var(--radius-md)]",
        className,
      )}
    >
      {children}
    </div>
  );
}

export function StatusDot({ tone }: { tone: "ok" | "warn" | "error" | "idle" }) {
  const color = {
    ok: "bg-success",
    warn: "bg-warning",
    error: "bg-destructive",
    idle: "bg-midground/40",
  }[tone];
  return <span aria-hidden className={cn("inline-block size-2 shrink-0 rounded-full", color)} />;
}

export function TextField({
  label,
  hint,
  className,
  ...props
}: React.InputHTMLAttributes<HTMLInputElement> & { label: string; hint?: ReactNode }) {
  return (
    <label className={cn("flex flex-col gap-1.5", className)}>
      <SectionLabel>{label}</SectionLabel>
      <input
        className={cn(
          "h-12 w-full border border-midground/15 bg-background/40 px-3.5",
          "font-mono text-base text-midground placeholder:text-text-disabled",
          "rounded-[var(--radius-sm)] transition-colors",
          "focus-visible:outline-none focus-visible:border-midground/40 focus-visible:ring-1 focus-visible:ring-midground/30",
        )}
        {...props}
      />
      {hint && <span className="text-xs text-text-tertiary">{hint}</span>}
    </label>
  );
}

export function EmptyState({
  icon,
  title,
  children,
}: {
  icon?: ReactNode;
  title: string;
  children?: ReactNode;
}) {
  return (
    <div className="flex flex-col items-center justify-center gap-3 px-6 py-16 text-center">
      {icon && <div className="text-midground/60 [&>svg]:size-10">{icon}</div>}
      <p className="font-mondwest text-display text-lg tracking-[0.08em] text-midground">{title}</p>
      {children && <div className="max-w-md text-sm text-text-secondary">{children}</div>}
    </div>
  );
}

/** A full-page view (Jobs, Skills, Bots, Servidor): optional top bar, scrolling body. */
export function PageShell({ leading, children }: { leading?: ReactNode; children: ReactNode }) {
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {leading && (
        <div className="flex h-14 shrink-0 items-center border-b border-current/20 px-2">{leading}</div>
      )}
      <div className="scroll-area min-h-0 flex-1">
        <div className="mx-auto flex w-full max-w-5xl flex-col gap-5 px-4 pt-6 pb-[calc(var(--safe-bottom)+2rem)] sm:px-8">
          {children}
        </div>
      </div>
    </div>
  );
}
