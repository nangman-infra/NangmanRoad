# Nangman Road

Nangman Road is an install-free network route visualizer. Visitors enter a domain or IP address, choose Traceout or MTR, and see the measured route on a live map with a terminal-style result view.

## Product Truth

A browser cannot run exact visitor-device `traceroute`, `mtr`, ICMP ping, raw sockets, or TTL-based probes.

Nangman Road therefore does not claim to trace directly from the visitor's PC. The honest model is:

1. The browser sends the target and UI context.
2. The backend validates the target.
3. The backend asks a distributed measurement provider, starting with Globalping, to measure from a nearby network probe.
4. The frontend visualizes the returned hops, locations, and terminal result.

Use this copy consistently:

- "Measured from a nearby network probe"
- "Install-free browser experience"
- "Not a direct trace from your device"
- "Exact device-level traceroute requires a local agent"

If exact visitor-device measurement is required later, this project needs a local agent, desktop app, or browser extension with a native helper.

## What It Does

- Traceout mode for a route-style view.
- MTR mode for repeated monitoring-style measurements.
- Server-Sent Events for realtime measurement updates.
- Light and dark themes.
- Route map with confidence-scored hop locations.
- Terminal result view for raw-ish trace/MTR output.
- Demo provider fallback when the real provider is unavailable.

## Measurement Notes

### Traceout

Traceout uses the provider traceroute result and visualizes reliable location points on the map.

### MTR

MTR is displayed as:

```bash
mtr -rwc 16 -z <target>
```

`-c 16` means 16 probe cycles, not 16 hops. The Globalping MTR API currently caps packet samples at 16, so the UI and terminal copy use 16 instead of pretending to run a local 30-cycle MTR.

Local `mtr -rwc 30 -z <target>` can differ because it runs from your own machine and sends more cycles. Exact local parity requires a local agent.

## Route Geolocation

The map does not blindly place every hop. It draws only confidence-scored locations, using evidence such as:

- coordinates returned by the measurement provider
- reverse-DNS city, airport, and network hints
- IP geolocation lookup
- ASN and known network patterns
- RTT sanity checks from the selected probe

Unknown or low-confidence hops stay in the terminal output instead of being forced onto the map.

This matters because public IP geolocation is often approximate. A server physically in Seoul may appear as Seongnam, Bundang, Tokyo, Hong Kong, or an ISP registration area depending on the database. Nangman Road tries to avoid fake precision by showing city or metro-level estimates when exact placement is not defensible.

## Stack

- React + TypeScript + Vite
- Tailwind CSS
- Framer Motion
- Leaflet
- Express
- Server-Sent Events
- Globalping API

## Local Setup

```bash
npm install
npm run dev
```

The dev script starts:

- Frontend: `http://127.0.0.1:5173`
- Backend: `http://127.0.0.1:8787`

Health check:

```bash
curl http://127.0.0.1:8787/api/health
```

Build check:

```bash
npm run check
npm run build
```

## Quality Checks

Current scripts:

```bash
npm run check   # TypeScript typecheck
npm run build   # TypeScript typecheck + Vite web build + Express server bundle
npm run start   # Run the production server from dist-server/index.js
```

Not configured yet:

- `lint`: no ESLint or Biome config is present.
- `format`: no Prettier or Biome config is present.
- `test`: no unit/integration test runner is present.

Before a production release, add linting and at least a focused test suite for target validation, provider parsing, and route geolocation inference.

## Docker

Build the production image:

```bash
docker build -t nangman-road .
```

Run it locally:

```bash
docker run --rm -p 8787:8787 --env-file .env nangman-road
```

The container serves both:

- frontend app from `dist/`
- backend API from `/api/*`

Health check:

```bash
curl http://127.0.0.1:8787/api/health
```

## CI/CD

This repository includes a `Jenkinsfile` for the existing Nangman infrastructure pipeline.

Before enabling the Jenkins job, confirm these values in `Jenkinsfile`:

- `REPO_SLUG`
- `DEFAULT_REPO_HTTP_URL`
- `IMAGE_NAME`
- `APP_HEALTH_URL`
- external port mapping in the on-prem Docker/Watchtower host
- SonarQube project key and Quality Gate policy

## Environment

Copy `.env.example` to `.env` when you need local configuration.

```bash
PORT=8787
GLOBALPING_API_URL=https://api.globalping.io/v1/measurements
GLOBALPING_TOKEN=
MEASUREMENT_PROVIDER=globalping
GEOIP_PROVIDER=ip-api
IPINFO_TOKEN=
GEOIP_TIMEOUT_MS=1400
REVERSE_DNS_TIMEOUT_MS=900
```

Provider options:

- `MEASUREMENT_PROVIDER=globalping`: use Globalping first.
- `MEASUREMENT_PROVIDER=demo`: use demo data only.
- `GLOBALPING_TOKEN`: optional, but useful for authenticated/provider-limited usage.

GeoIP options:

- `GEOIP_PROVIDER=ip-api`: development default.
- `GEOIP_PROVIDER=ipinfo`: requires `IPINFO_TOKEN`.
- `GEOIP_PROVIDER=none`: disables external IP geolocation.

For production, use a licensed GeoIP source or a local database if possible. Free public APIs are useful for development, but they can have rate limits, terms, and stale location records.

## API

### `GET /api/health`

Returns backend status.

### `POST /api/measurements`

```json
{
  "target": "example.com",
  "mode": "traceout"
}
```

`mode` can be:

- `traceout`
- `mtr`

### `GET /api/measurements/:id/events`

Streams Server-Sent Events:

- `measurement_started`
- `hop_result`
- `metric_update`
- `measurement_finished`
- `error`

## Security Rules

- Never pass user input directly into shell commands.
- Validate targets as domains or IP addresses.
- Reject spaces, shell operators, redirects, pipes, semicolons, and unusual characters.
- Keep provider API keys on the backend only.
- Apply rate limits, timeouts, and cancellation.
- Do not expose raw provider errors or server internals to users.

## GitHub Publishing Checklist

Commit these:

- `src/`, `server/`, `shared/`, `scripts/`
- `README.md`
- `AGENTS.md`
- `Dockerfile`
- `Jenkinsfile`
- `.dockerignore`
- `.env.example`
- `package.json`
- `package-lock.json`
- config files such as `vite.config.ts`, `tailwind.config.ts`, `tsconfig.json`, `postcss.config.js`

Do not commit these:

- `.env` or any real API token
- `node_modules/`
- `dist/` or build output unless a deployment workflow explicitly needs it
- local logs, coverage output, screenshots, temporary files, and `.DS_Store`
- future measurement databases containing user-entered domains, IPs, or visitor metadata
- reference screenshots from Pinterest, Google Antigravity, or other sites unless you have rights to redistribute them

## License And Attribution

No project license has been selected yet. If this repo is published without a `LICENSE` file, the source is visible but not clearly reusable by others. Before making it public as open source, choose a license intentionally.

Recommended options:

- MIT: simple and common for web apps.
- Apache-2.0: similar, but includes an explicit patent grant.
- Private/no license: acceptable if this is only a personal or closed-source project.

Third-party notes:

- Keep the OpenStreetMap and CARTO attribution visible on the map.
- Leaflet, React, Vite, Tailwind, Express, and related npm packages are mostly permissive-license dependencies. Check `package-lock.json` before a formal release.
- Follow Globalping API limits and terms. Do not hardcode or publish tokens.

## Example Targets

- `google.com`
- `cloudflare.com`
- `1.1.1.1`
- `overclockers.com.au`
