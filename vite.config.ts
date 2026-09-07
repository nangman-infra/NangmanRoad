import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

const apiProxyTarget = process.env.API_PROXY_TARGET ?? "http://127.0.0.1:8787";

export default defineConfig({
  // Stamped into the data URLs, so a rebuilt page never reads a data file the browser cached
  // from the build before it (the server lets /data be cached for a day).
  define: { __BUILD_ID__: JSON.stringify(Date.now().toString(36)) },
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      "/api": apiProxyTarget
    }
  }
});
