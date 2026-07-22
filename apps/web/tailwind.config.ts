import type { Config } from "tailwindcss";

const config: Config = {
  content: ["./app/**/*.{ts,tsx}", "./components/**/*.{ts,tsx}"],
  theme: {
    extend: {
      colors: {
        // Ledger-inspired token system: warm paper surface, deep ink navy for structure,
        // marigold as the single accent (used sparingly for actions + positive milestones).
        paper: "#F6F4EE",
        surface: "#FFFFFF",
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
        line: "#E4E0D4",
      },
      fontFamily: {
        // Display/body pairing: a grounded slab-ish serif for headings (ledger-book feel),
        // a clean grotesque for body copy, and tabular mono reserved for money amounts.
        display: ["Georgia", "Iowan Old Style", "serif"],
        sans: ["-apple-system", "Segoe UI", "Helvetica Neue", "system-ui", "sans-serif"],
        mono: ["ui-monospace", "SFMono-Regular", "Menlo", "monospace"],
      },
    },
  },
  plugins: [],
};

export default config;
