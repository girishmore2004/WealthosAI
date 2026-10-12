import type { Config } from "tailwindcss";

// Every colour is a CSS variable holding an "R G B" channel triplet (defined per theme in
// app/globals.css), so Tailwind opacity modifiers such as `bg-loss/5` or `ring-marigold-500/30`
// keep working and both themes share one set of class names.
const token = (name: string) => `rgb(var(--${name}) / <alpha-value>)`;

const config: Config = {
  content: ["./app/**/*.{ts,tsx}", "./components/**/*.{ts,tsx}"],
  theme: {
    extend: {
      colors: {
        // Semantic names kept from the original token system so no component needs to change:
        // paper = page background, surface = cards, ink = text, line = borders,
        // marigold = the primary accent (links, active states, primary actions).
        paper: token("paper"),
        surface: token("surface"),
        "surface-muted": token("surface-muted"),
        sidebar: token("sidebar"),
        ink: {
          DEFAULT: token("ink"),
          soft: token("ink-soft"),
          faint: token("ink-faint"),
        },
        marigold: {
          50: token("accent-tint"),
          400: token("accent-400"),
          500: token("accent"),
          600: token("accent-600"),
        },
        accent2: token("accent-2"),
        onaccent: token("on-accent"),
        gain: token("gain"),
        loss: token("loss"),
        warn: token("warn"),
        line: token("line"),
        // Fixed dark band used by the marketing "AI" section in both themes.
        night: "#0B1020",
        "night-fg": "#F1F5F9",
      },
      fontFamily: {
        // Display/body pairing: a grounded serif for headings, a clean grotesque for body copy,
        // and tabular mono reserved for money amounts.
        display: ["Georgia", "Iowan Old Style", "serif"],
        sans: ["-apple-system", "Segoe UI", "Helvetica Neue", "system-ui", "sans-serif"],
        mono: ["ui-monospace", "SFMono-Regular", "Menlo", "monospace"],
      },
      borderRadius: {
        sm: "0.375rem",
        DEFAULT: "0.5rem",
        md: "0.625rem",
        lg: "0.875rem",
      },
      boxShadow: {
        card: "var(--shadow-card)",
        "card-hover": "var(--shadow-card-hover)",
        popover: "var(--shadow-popover)",
      },
      spacing: {
        4.5: "1.125rem",
        18: "4.5rem",
      },
      transitionDuration: {
        DEFAULT: "150ms",
      },
    },
  },
  plugins: [],
};

export default config;
