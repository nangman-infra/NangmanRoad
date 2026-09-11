import { nanoid } from "nanoid";
import type {
  MeasurementEvent,
  MeasurementResult,
  MeasurementStatus,
  TraceMode, TraceProtocol,
  VisitorContext
} from "../shared/types";
import { runDemoMeasurement } from "./providers/demoProvider";
import { runGlobalpingMeasurement } from "./providers/globalpingProvider";

type Listener = (event: MeasurementEvent) => void;

interface Session {
  id: string;
  target: string;
  mode: TraceMode;
  from?: string;
  protocol?: TraceProtocol;
  status: MeasurementStatus;
  createdAt: number;
  events: MeasurementEvent[];
  listeners: Set<Listener>;
  cleanupTimer?: ReturnType<typeof setTimeout>;
}

const sessions = new Map<string, Session>();
const SESSION_TTL_MS = Number(process.env.SESSION_TTL_MS ?? 15 * 60_000);
const FINISHED_SESSION_TTL_MS = Number(process.env.FINISHED_SESSION_TTL_MS ?? 2 * 60_000);
const MAX_SESSIONS = Number(process.env.MAX_SESSIONS ?? 500);

function deleteSession(session: Session) {
  if (session.cleanupTimer) {
    clearTimeout(session.cleanupTimer);
  }

  session.listeners.clear();
  sessions.delete(session.id);
}

function scheduleSessionCleanup(session: Session, delayMs: number) {
  if (session.cleanupTimer) {
    clearTimeout(session.cleanupTimer);
  }

  session.cleanupTimer = setTimeout(() => deleteSession(session), delayMs);
}

function cleanupExpiredSessions(now = Date.now()) {
  for (const session of sessions.values()) {
    if (now - session.createdAt > SESSION_TTL_MS) {
      deleteSession(session);
    }
  }
}

function enforceSessionLimit() {
  while (sessions.size >= MAX_SESSIONS) {
    const oldest: Session | undefined = sessions.values().next().value;

    if (!oldest) {
      return;
    }

    deleteSession(oldest);
  }
}

function publish(session: Session, event: MeasurementEvent) {
  session.events.push(event);

  if (event.type === "measurement_started") {
    session.status = "running";
  }

  if (event.type === "measurement_finished") {
    session.status = "finished";
    scheduleSessionCleanup(session, FINISHED_SESSION_TTL_MS);
  }

  if (event.type === "error") {
    session.status = "error";
    scheduleSessionCleanup(session, FINISHED_SESSION_TTL_MS);
  }

  for (const listener of session.listeners) {
    listener(event);
  }
}

// The provider reports a name that does not resolve the same way it reports its own outages.
// Telling them apart matters: one is a typo the visitor can fix, the other is ours to own.
function failureMessage(error: unknown, target: string) {
  const detail = error instanceof Error ? error.message : "";

  if (/enotfound|nxdomain|querya |could not resolve|no such host/i.test(detail)) {
    return `No DNS record found for ${target}. Check the spelling, or enter an IP address.`;
  }

  const budget = /hourly limit reached; resets in (\d+) min/.exec(detail);

  if (budget) {
    return `This hour's measurement budget is used up. Try again in about ${budget[1]} minutes.`;
  }

  return "Measurement is temporarily unavailable. Please try again later.";
}

async function runDemoOnly(session: Session, visitor?: VisitorContext) {
  try {
    for await (const event of runDemoMeasurement({
      id: session.id,
      target: session.target,
      mode: session.mode,
      visitor
    })) {
      publish(session, event);
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : "Demo provider unavailable.";
    console.warn(`Demo provider unavailable for ${session.id}. ${message}`);
    publish(session, {
      type: "error",
      payload: { message: "Measurement is temporarily unavailable. Please try again later." }
    });
  }
}

async function runMeasurement(session: Session, visitor?: VisitorContext) {
  // Demo data is a deliberate offline mode, never a safety net. A failed measurement used to
  // fall through to it, so a domain that does not exist came back as a map of RFC 5737
  // documentation addresses with invented latencies and nothing marking them as fake. Saying
  // nothing is worse than saying "this failed"; a route the visitor cannot tell from a real
  // one is worse than both.
  if (process.env.MEASUREMENT_PROVIDER === "demo") {
    await runDemoOnly(session, visitor);
    return;
  }

  try {
    for await (const event of runGlobalpingMeasurement({
      id: session.id,
      target: session.target,
      mode: session.mode,
      from: session.from,
      protocol: session.protocol,
      visitor
    })) {
      publish(session, event);
    }
  } catch (error) {
    const detail = error instanceof Error ? error.message : "Unknown error.";
    console.warn(`Measurement failed for ${session.id}. ${detail}`);
    publish(session, {
      type: "error",
      payload: { message: failureMessage(error, session.target) }
    });
  }
}

export function createSession(params: {
  target: string;
  mode: TraceMode;
  from?: string;
  protocol?: TraceProtocol;
  visitor?: VisitorContext;
}) {
  cleanupExpiredSessions();
  enforceSessionLimit();

  const session: Session = {
    id: nanoid(10),
    target: params.target,
    mode: params.mode,
    from: params.from,
    protocol: params.protocol,
    status: "starting",
    createdAt: Date.now(),
    events: [],
    listeners: new Set()
  };

  sessions.set(session.id, session);
  scheduleSessionCleanup(session, SESSION_TTL_MS);
  void runMeasurement(session, params.visitor);

  return {
    id: session.id,
    status: session.status
  };
}

export function getSession(id: string) {
  return sessions.get(id);
}

export function subscribe(session: Session, listener: Listener) {
  session.listeners.add(listener);

  for (const event of session.events) {
    listener(event);
  }

  return () => {
    session.listeners.delete(listener);
  };
}

export function latestResult(session: Session): MeasurementResult | undefined {
  for (let index = session.events.length - 1; index >= 0; index -= 1) {
    const event = session.events[index];

    if (event.type === "measurement_finished" || event.type === "measurement_started") {
      return event.payload;
    }
  }

  return undefined;
}
