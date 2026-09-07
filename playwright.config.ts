import { defineConfig } from "@playwright/test";

// The built app served by the real server in its offline demo mode: no probe, no GeoIP,
// so the run costs nothing and needs no network. The visitor's own Chrome does the driving.
const port = 8790;

export default defineConfig({
  testDir: "e2e",
  timeout: 120_000,
  use: { baseURL: `http://127.0.0.1:${port}`, channel: "chrome", trace: "retain-on-failure" },
  webServer: {
    command: "npm run build:web && npm run build:server && node dist-server/index.js",
    url: `http://127.0.0.1:${port}/`,
    env: { PORT: String(port), MEASUREMENT_PROVIDER: "demo", GEOIP_PROVIDER: "none", GEOIP_SECONDARY: "none", RIPE_IPMAP: "off" },
    reuseExistingServer: false,
    timeout: 240_000
  }
});
