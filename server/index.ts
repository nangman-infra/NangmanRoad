import { geoBudget, peeringDbSummary } from "./geoInference";
import { globalpingBudget } from "./providers/globalpingProvider";
import { timingSafeEqual } from "node:crypto";
import path from "node:path";
import compression from "compression";
import { fileURLToPath } from "node:url";
import express from "express";
import cors from "cors";
import { createSession, getSession, subscribe } from "./sessionStore";
import { rateLimit } from "./rateLimit";
import { applySecurityHeaders, corsOptions } from "./security";
import { sendIndexHtml, sendRobotsTxt, sendSitemapXml } from "./seo";
import { normalizeMode, normalizeProbeId, normalizeTarget } from "./validation";
import type { CreateMeasurementRequest, MeasurementEvent } from "../shared/types";

// Same length or not, the comparison takes the same time, so a caller learns nothing from
// how long a wrong key took to reject.
function timingSafeEqualString(given: string, expected: string) {
  const a = Buffer.from(given.padEnd(expected.length).slice(0, expected.length));
  const b = Buffer.from(expected);

  return timingSafeEqual(a, b) && given.length === expected.length;
}

const app = express();
const port = Number(process.env.PORT ?? 8787);
const currentFile = fileURLToPath(import.meta.url);
const currentDirectory = path.dirname(currentFile);
const clientDistDirectory = process.env.CLIENT_DIST_DIR ?? path.resolve(currentDirectory, "../dist");
const clientIndexPath = path.join(clientDistDirectory, "index.html");

if (process.env.TRUST_PROXY) {
  app.set("trust proxy", process.env.TRUST_PROXY);
}

app.disable("x-powered-by");
app.use(applySecurityHeaders);
app.use(cors(corsOptions));
app.use(express.json({ limit: "24kb" }));

app.get("/robots.txt", sendRobotsTxt);
app.get("/sitemap.xml", sendSitemapXml);

// What is left of the free tiers this deployment runs on, for whoever set BUDGET_REPORT_KEY
// and knows it. Counts and clocks only: no key, token or address is read back, so the worst
// a leaked report says is how busy the hour has been. The key is compared in constant time
// and an empty one turns the route off entirely, which is what an unconfigured deploy gets.
app.get("/api/budget", async (req, res) => {
  const expected = process.env.BUDGET_REPORT_KEY?.trim() ?? "";
  const given = typeof req.query.key === "string" ? req.query.key : "";

  if (expected.length === 0 || !timingSafeEqualString(given, expected)) {
    res.status(404).json({ error: "Not found." });
    return;
  }

  res.json({ measurements: await globalpingBudget(), geolocation: geoBudget(), uptimeSeconds: Math.round(process.uptime()) });
});

app.get("/api/health", (_req, res) => {
  res.json({
    ok: true,
    service: "nangman-road-api",
    provider: process.env.MEASUREMENT_PROVIDER ?? "globalping"
  });
});

app.post("/api/measurements", rateLimit, (req, res) => {
  try {
    const body = req.body as Partial<CreateMeasurementRequest>;
    const target = normalizeTarget(body.target);
    const mode = normalizeMode(body.mode);
    const from = normalizeProbeId(body.from);
    const visitor =
      body.visitor && typeof body.visitor === "object"
        ? {
            timeZone:
              typeof body.visitor.timeZone === "string" ? body.visitor.timeZone.slice(0, 80) : undefined,
            locale: typeof body.visitor.locale === "string" ? body.visitor.locale.slice(0, 40) : undefined
          }
        : undefined;

    const session = createSession({ target, mode, from, visitor });
    res.status(202).json(session);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Invalid measurement request.";
    res.status(400).json({ error: message });
  }
});

app.get("/api/measurements/:id/events", (req, res) => {
  const session = getSession(req.params.id);

  if (!session) {
    res.status(404).json({ error: "Measurement not found." });
    return;
  }

  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache, no-transform");
  res.setHeader("Connection", "keep-alive");
  // nginx buffers proxied responses by default, which holds every event until the stream ends.
  // It honors this header per response, so the reverse proxy needs no config change.
  res.setHeader("X-Accel-Buffering", "no");
  res.flushHeaders?.();
  // Give any intermediary a first byte immediately instead of waiting on the first event.
  res.write(": connected\n\n");

  const send = (event: MeasurementEvent) => {
    res.write(`event: ${event.type}\n`);
    res.write(`data: ${JSON.stringify(event)}\n\n`);
  };

  const unsubscribe = subscribe(session, send);
  const keepAlive = setInterval(() => {
    res.write(": keep-alive\n\n");
  }, 15_000);

  req.on("close", () => {
    clearInterval(keepAlive);
    unsubscribe();
    res.end();
  });
});

// The route data the browser's worker loads - cables, coastlines, landings, corridors -
// is a few megabytes of JSON that shrinks to a fifth compressed; the hashed bundles never
// change under their name, the data files change only with a data refresh.
app.use(compression());
app.use(
  express.static(clientDistDirectory, {
    index: false,
    setHeaders(res, filePath) {
      if (/[\\/]assets[\\/]/.test(filePath)) {
        res.setHeader("Cache-Control", "public, max-age=31536000, immutable");
      } else if (/[\\/]data[\\/].+\.json$/.test(filePath)) {
        res.setHeader("Cache-Control", "public, max-age=86400, stale-while-revalidate=604800");
      }
    }
  })
);

app.get("*", (req, res) => {
  if (req.path.startsWith("/api")) {
    res.status(404).json({ error: "Not found." });
    return;
  }

  sendIndexHtml(req, res, clientIndexPath).catch(() => {
    res.status(404).json({ error: "Not found." });
  });
});

app.use((_req, res) => {
  res.status(404).json({ error: "Not found." });
});

app.listen(port, () => {
  console.log(`Nangman Road listening on http://127.0.0.1:${port}`);
  console.log(peeringDbSummary());
});
