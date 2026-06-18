import type { Request, Response, NextFunction } from "express";

const WINDOW_MS = 60_000;
const HOUR_WINDOW_MS = 60 * 60_000;
const MAX_REQUESTS_PER_MINUTE = Number(process.env.RATE_LIMIT_PER_MINUTE ?? 8);
const MAX_REQUESTS_PER_HOUR = Number(process.env.RATE_LIMIT_PER_HOUR ?? 80);
const buckets = new Map<string, { minuteCount: number; minuteResetAt: number; hourCount: number; hourResetAt: number }>();

function cleanupBuckets(now: number) {
  for (const [key, bucket] of buckets) {
    if (bucket.minuteResetAt < now && bucket.hourResetAt < now) {
      buckets.delete(key);
    }
  }
}

function clientKey(req: Request) {
  return req.ip || req.socket.remoteAddress || "unknown";
}

export function rateLimit(req: Request, res: Response, next: NextFunction) {
  const now = Date.now();
  const key = clientKey(req);
  const bucket = buckets.get(key);

  if (!bucket) {
    cleanupBuckets(now);
    buckets.set(key, {
      minuteCount: 1,
      minuteResetAt: now + WINDOW_MS,
      hourCount: 1,
      hourResetAt: now + HOUR_WINDOW_MS
    });
    next();
    return;
  }

  if (bucket.minuteResetAt < now) {
    bucket.minuteCount = 0;
    bucket.minuteResetAt = now + WINDOW_MS;
  }

  if (bucket.hourResetAt < now) {
    bucket.hourCount = 0;
    bucket.hourResetAt = now + HOUR_WINDOW_MS;
  }

  if (bucket.minuteCount >= MAX_REQUESTS_PER_MINUTE || bucket.hourCount >= MAX_REQUESTS_PER_HOUR) {
    res.status(429).json({
      error: "Too many measurement requests. Please wait a minute and try again."
    });
    return;
  }

  bucket.minuteCount += 1;
  bucket.hourCount += 1;
  next();
}
