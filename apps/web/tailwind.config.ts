import type { Config } from "tailwindcss";

const config: Config = {
  content: ["./app/**/*.{ts,tsx}", "./components/**/*.{ts,tsx}"],
  theme: {
    extend: {
      colors: {
        // Ledger-inspired token system: warm paper surface, deep ink navy for structure,
        // marigold as the single accent (used sparingly for actions + positive milestones).
        paper: "#F7F5EF",
        surface: "#FFFFFF",
        "surface-muted": "#FBF9F3",
        ink: {
          DEFAULT: "#151E2E",
          soft: "#4B5568",
          faint: "#8A93A6",
        },
        marigold: {
          50: "#FDF4E4",
          400: "#E3A94A",
          500: "#D98F2B",
          600: "#B8721C",
        },
        gain: "#2F7D5D",
        loss: "#B3462C",
        line: "#E9E5D8",
      },
      fontFamily: {
        // Display/body pairing: a grounded slab-ish serif for headings (ledger-book feel),
        // a clean grotesque for body copy, and tabular mono reserved for money amounts.
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
        card: "0 1px 2px rgba(21, 30, 46, 0.04)",
        "card-hover": "0 8px 24px -12px rgba(21, 30, 46, 0.16)",
        popover: "0 12px 32px -8px rgba(21, 30, 46, 0.22)",
      },
      spacing: {
        4.5: "1.125rem",
        18: "4.5rem",
      },
    },
  },
  plugins: [],
};

export default config;
