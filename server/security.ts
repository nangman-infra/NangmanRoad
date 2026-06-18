import { randomBytes } from "node:crypto";
import type { NextFunction, Request, Response } from "express";
import type { CorsOptionsDelegate } from "cors";

const developmentOrigins = new Set([
  "http://127.0.0.1:5173",
  "http://localhost:5173",
  "http://127.0.0.1:8787",
  "http://localhost:8787"
]);

function envList(name: string) {
  return (process.env[name] ?? "")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);
}

function isSameHostOrigin(origin: string, req: Request) {
  const host = req.get("host");

  if (!host) {
    return false;
  }

  try {
    return new URL(origin).host === host;
  } catch {
    return false;
  }
}

export const corsOptions: CorsOptionsDelegate<Request> = (req, callback) => {
  const origin = req.get("origin");

  if (!origin) {
    callback(null, { origin: false });
    return;
  }

  const allowedOrigins = new Set(envList("ALLOWED_ORIGINS"));
  const allowDevelopmentOrigin =
    process.env.NODE_ENV !== "production" && developmentOrigins.has(origin);
  const allowed =
    allowedOrigins.has(origin) ||
    allowDevelopmentOrigin ||
    isSameHostOrigin(origin, req);

  callback(null, {
    origin: allowed ? origin : false,
    methods: ["GET", "POST", "OPTIONS"],
    allowedHeaders: ["content-type"],
    maxAge: 600
  });
};

export function applySecurityHeaders(_req: Request, res: Response, next: NextFunction) {
  const nonce = randomBytes(16).toString("base64");
  res.locals.cspNonce = nonce;
  const cartoTileHosts = "https://a.basemaps.cartocdn.com https://b.basemaps.cartocdn.com https://c.basemaps.cartocdn.com https://d.basemaps.cartocdn.com";
  const csp = [
    "default-src 'self'",
    "base-uri 'self'",
    "object-src 'none'",
    "frame-ancestors 'none'",
    "form-action 'self'",
    `script-src 'self' 'nonce-${nonce}'`,
    "style-src 'self' 'unsafe-inline'",
    `img-src 'self' data: blob: ${cartoTileHosts}`,
    "font-src 'self' data:",
    "connect-src 'self'",
    "worker-src 'self'",
    "manifest-src 'self'"
  ].join("; ");

  res.setHeader("Content-Security-Policy", csp);
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("X-Frame-Options", "DENY");
  res.setHeader("Referrer-Policy", "no-referrer");
  res.setHeader("Cross-Origin-Opener-Policy", "same-origin");
  res.setHeader("Cross-Origin-Resource-Policy", "same-origin");
  res.setHeader("Permissions-Policy", "camera=(), microphone=(), geolocation=(), payment=(), usb=()");

  if (process.env.ENABLE_HSTS !== "false") {
    res.setHeader("Strict-Transport-Security", "max-age=15552000; includeSubDomains");
  }

  next();
}
