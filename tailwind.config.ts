import type { Config } from "tailwindcss";

const config: Config = {
  content: [
    "./app/**/*.{ts,tsx}",
    "./components/**/*.{ts,tsx}",
  ],
  theme: {
    extend: {
      colors: {
        // Instrument-dark workspace
        base: "#0E1116",
        panel: "#161A22",
        panel2: "#1C2230",
        line: "#262E3D",
        ink: "#E6E9EF",
        muted: "#8A93A3",
        faint: "#5A6473",
        // Oscilloscope teal — the one accent, used with restraint
        trace: "#3DD6C4",
        // Fault severity
        fatal: "#FF5C5C",
        warn: "#F2B544",
        ok: "#48C78E",
      },
      fontFamily: {
        mono: ["var(--font-mono)", "ui-monospace", "SFMono-Regular", "Menlo", "monospace"],
        sans: ["var(--font-sans)", "ui-sans-serif", "system-ui", "sans-serif"],
      },
      keyframes: {
        sweep: {
          "0%": { transform: "translateX(-100%)" },
          "100%": { transform: "translateX(400%)" },
        },
        pulseDot: {
          "0%,100%": { opacity: "0.35" },
          "50%": { opacity: "1" },
        },
      },
      animation: {
        sweep: "sweep 1.4s ease-in-out infinite",
        pulseDot: "pulseDot 1.1s ease-in-out infinite",
      },
    },
  },
  plugins: [],
};
export default config;
