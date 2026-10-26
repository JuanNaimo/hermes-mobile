import { cn } from "@/lib/utils";

/**
 * Dashboard mode's profile picker: a row of chips, optionally led by "Todos"
 * (`all`) for views that can span every profile.
 */
export function ProfileChips({
  profiles,
  value,
  onChange,
  includeAll = true,
  className,
  label = "Perfil",
}: {
  profiles: string[];
  value: string;
  onChange: (p: string) => void;
  includeAll?: boolean;
  className?: string;
  label?: string;
}) {
  return (
    <div role="radiogroup" aria-label={label} className={cn("flex gap-1.5 overflow-x-auto scrollbar-none", className)}>
      {(includeAll ? ["all", ...profiles] : profiles).map((p) => (
        <button
          key={p}
          type="button"
          role="radio"
          aria-checked={value === p}
          onClick={() => onChange(p)}
          className={cn(
            "h-9 shrink-0 border px-3 text-sm transition-colors rounded-[var(--radius-sm)]",
            value === p
              ? "border-midground bg-midground text-background-base"
              : "border-current/20 text-text-secondary hover:text-midground",
          )}
        >
          {p === "all" ? "Todos" : p}
        </button>
      ))}
    </div>
  );
}
