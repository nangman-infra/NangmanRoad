import type { Config } from "tailwindcss";

export default {
  content: ["./index.html", "./src/**/*.{ts,tsx}"],
  theme: {
    extend: {
      colors: {
        deep: {
          950: "#050812",
          900: "#07101f",
          800: "#0c1729"
        },
        signal: {
          cyan: "#5ee7ff",
          coral: "#ff756c",
          amber: "#f6c65b",
          violet: "#8f88ff"
        }
      },
      boxShadow: {
        glow: "0 0 36px rgba(94, 231, 255, 0.28)",
        coral: "0 0 28px rgba(255, 117, 108, 0.26)"
      }
    }
  },
  plugins: []
} satisfies Config;
