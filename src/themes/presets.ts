import nousArtwork from "@nous-research/ui/assets/filler-bg0.webp";

/**
 * Dashboard palettes, mirrored from hermes-agent `web/src/themes/presets.ts`
 * so the mobile client looks like the dashboard. The Nous DS reads three
 * layers: background, midground (text + accent) and foreground (overlay).
 */
export interface MobileTheme {
  name: string;
  label: string;
  background: string;
  midground: string;
  /** Accent glow used for the backdrop vignette. */
  glow: string;
  fontSans?: string;
  fontMono?: string;
  fontUrl?: string;
  radius: string;
  light?: boolean;
  /** Full-bleed engraving behind the UI (the nousresearch.com "filler"). */
  artwork?: string;
  /** Shows the Nous mascot next to the Hermes wordmark. */
  nousBrand?: boolean;
}

const SYSTEM_SANS =
  'system-ui, -apple-system, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif';
const SYSTEM_MONO = 'ui-monospace, "SF Mono", "Cascadia Mono", Menlo, Consolas, monospace';

export const THEMES: MobileTheme[] = [
  {
    name: "default",
    label: "Hermes Teal",
    background: "#041c1c",
    midground: "#ffe6cb",
    glow: "rgba(255, 189, 56, 0.35)",
    radius: "0.5rem",
  },
  {
    // nousresearch.com: the DS "LENS_5I" lens (#170d02 / #FFAC02) seen through
    // its white `difference` layer, i.e. Nous blue on cream, over the
    // engraving filler, with Collapse + Courier Prime and square corners.
    name: "nous",
    label: "Nous Research",
    background: "#E8F2FD",
    midground: "#0053FD",
    glow: "rgba(0, 66, 199, 0.22)",
    fontSans: `"Collapse", ${SYSTEM_SANS}`,
    fontMono: `"Courier Prime", ${SYSTEM_MONO}`,
    fontUrl: "https://fonts.googleapis.com/css2?family=Courier+Prime:wght@400;700&display=swap",
    radius: "0",
    light: true,
    artwork: nousArtwork,
    nousBrand: true,
  },
  {
    name: "midnight",
    label: "Midnight",
    background: "#08081c",
    midground: "#ddd6ff",
    glow: "rgba(139, 128, 232, 0.3)",
    fontSans: `"Inter", ${SYSTEM_SANS}`,
    fontMono: `"JetBrains Mono", ${SYSTEM_MONO}`,
    fontUrl:
      "https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&family=JetBrains+Mono:wght@400;500;700&display=swap",
    radius: "0.75rem",
  },
  {
    name: "ember",
    label: "Ember",
    background: "#160800",
    midground: "#ffd8b0",
    glow: "rgba(217, 115, 22, 0.3)",
    fontSans: `"Spectral", Georgia, "Times New Roman", serif`,
    fontMono: `"IBM Plex Mono", ${SYSTEM_MONO}`,
    fontUrl:
      "https://fonts.googleapis.com/css2?family=Spectral:wght@400;500;600;700&family=IBM+Plex+Mono:wght@400;500;700&display=swap",
    radius: "0.25rem",
  },
  {
    name: "mono",
    label: "Mono",
    background: "#0e0e0e",
    midground: "#eaeaea",
    glow: "rgba(154, 154, 154, 0.3)",
    fontSans: `"IBM Plex Sans", ${SYSTEM_SANS}`,
    fontMono: `"IBM Plex Mono", ${SYSTEM_MONO}`,
    fontUrl:
      "https://fonts.googleapis.com/css2?family=IBM+Plex+Sans:wght@400;500;600&family=IBM+Plex+Mono:wght@400;500&display=swap",
    radius: "0",
  },
  {
    name: "cyberpunk",
    label: "Cyberpunk",
    background: "#000a00",
    midground: "#00ff41",
    glow: "rgba(0, 255, 65, 0.25)",
    fontSans: `"Share Tech Mono", "JetBrains Mono", ${SYSTEM_MONO}`,
    fontMono: `"Share Tech Mono", "JetBrains Mono", ${SYSTEM_MONO}`,
    fontUrl:
      "https://fonts.googleapis.com/css2?family=Share+Tech+Mono&family=JetBrains+Mono:wght@400;700&display=swap",
    radius: "0",
  },
  {
    name: "rose",
    label: "Rosé",
    background: "#1a0f15",
    midground: "#ffd4e1",
    glow: "rgba(249, 168, 212, 0.3)",
    fontSans: `"Fraunces", Georgia, serif`,
    fontMono: `"DM Mono", ${SYSTEM_MONO}`,
    fontUrl:
      "https://fonts.googleapis.com/css2?family=Fraunces:opsz,wght@9..144,400;9..144,500;9..144,600&family=DM+Mono:wght@400;500&display=swap",
    radius: "1rem",
  },
  {
    name: "nous-blue",
    label: "Nous Blue",
    background: "#E8F2FD",
    midground: "#0053FD",
    glow: "rgba(0, 83, 253, 0.12)",
    radius: "0.5rem",
    light: true,
  },
];

export const TEXT_SIZES = { normal: "16px", large: "18px" } as const;
export type TextSize = keyof typeof TEXT_SIZES;

const injectedFonts = new Set<string>();

export function applyTheme(theme: MobileTheme, textSize: TextSize) {
  const root = document.documentElement;
  const set = (k: string, v: string) => root.style.setProperty(k, v);
  set("--background", `color-mix(in srgb, ${theme.background} 100%, transparent)`);
  set("--background-base", theme.background);
  set("--background-alpha", "1");
  set("--midground", `color-mix(in srgb, ${theme.midground} 100%, transparent)`);
  set("--midground-base", theme.midground);
  set("--midground-alpha", "1");
  set("--foreground", "color-mix(in srgb, #ffffff 0%, transparent)");
  set("--foreground-base", theme.light ? "#170d02" : "#ffffff");
  set("--foreground-alpha", "0");
  set("--theme-glow", theme.glow);
  set("--theme-font-sans", theme.fontSans ?? SYSTEM_SANS);
  set("--theme-font-mono", theme.fontMono ?? SYSTEM_MONO);
  set("--theme-radius", theme.radius);
  set("--radius", theme.radius);
  set("--theme-base-size", TEXT_SIZES[textSize]);
  set("--theme-artwork", theme.artwork ? `url("${theme.artwork}")` : "none");
  root.dataset.theme = theme.name;
  root.dataset.scheme = theme.light ? "light" : "dark";
  root.style.colorScheme = theme.light ? "light" : "dark";
  document.querySelector('meta[name="theme-color"]')?.setAttribute("content", theme.background);

  if (theme.fontUrl && !injectedFonts.has(theme.fontUrl)) {
    injectedFonts.add(theme.fontUrl);
    const link = document.createElement("link");
    link.rel = "stylesheet";
    link.href = theme.fontUrl;
    document.head.appendChild(link);
  }
}

export function findTheme(name: string): MobileTheme {
  return THEMES.find((t) => t.name === name) ?? THEMES[0];
}
