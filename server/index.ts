import path from "node:path";
import { fileURLToPath } from "node:url";
import express from "express";
import cors from "cors";
import { createSession, getSession, subscribe } from "./sessionStore";
import { rateLimit } from "./rateLimit";
import { applySecurityHeaders, corsOptions } from "./security";
import { sendIndexHtml, sendRobotsTxt, sendSitemapXml } from "./seo";
import { normalizeMode, normalizeTarget } from "./validation";
import type { CreateMeasurementRequest, MeasurementEvent } from "../shared/types";

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
    const visitor =
      body.visitor && typeof body.visitor === "object"
        ? {
            timeZone:
              typeof body.visitor.timeZone === "string" ? body.visitor.timeZone.slice(0, 80) : undefined,
            locale: typeof body.visitor.locale === "string" ? body.visitor.locale.slice(0, 40) : undefined
          }
        : undefined;

    const session = createSession({ target, mode, visitor });
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
  res.flushHeaders?.();

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

app.use(express.static(clientDistDirectory, { index: false }));

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
});
