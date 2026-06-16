import type { Request, Response, NextFunction } from "express";

const WINDOW_MS = 60_000;
const MAX_REQUESTS = 20;
const buckets = new Map<string, { count: number; resetAt: number }>();

export function rateLimit(req: Request, res: Response, next: NextFunction) {
  const now = Date.now();
  const key = req.ip || req.socket.remoteAddress || "unknown";
  const bucket = buckets.get(key);

  if (!bucket || bucket.resetAt < now) {
    buckets.set(key, { count: 1, resetAt: now + WINDOW_MS });
    next();
    return;
  }

  if (bucket.count >= MAX_REQUESTS) {
    res.status(429).json({
      error: "Too many measurement requests. Please wait a minute and try again."
    });
    return;
  }

  bucket.count += 1;
  next();
}
