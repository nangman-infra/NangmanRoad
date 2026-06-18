import { nanoid } from "nanoid";
import type {
  MeasurementEvent,
  MeasurementResult,
  MeasurementStatus,
  TraceMode,
  VisitorContext
} from "../shared/types";
import { runDemoMeasurement } from "./providers/demoProvider";
import { runGlobalpingMeasurement } from "./providers/globalpingProvider";

type Listener = (event: MeasurementEvent) => void;

interface Session {
  id: string;
  target: string;
  mode: TraceMode;
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
    const oldest = sessions.values().next().value as Session | undefined;

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

async function runMeasurement(session: Session, visitor?: VisitorContext) {
  const useDemoOnly = process.env.MEASUREMENT_PROVIDER === "demo";

  try {
    if (!useDemoOnly) {
      for await (const event of runGlobalpingMeasurement({
        id: session.id,
        target: session.target,
        mode: session.mode,
        visitor
      })) {
        publish(session, event);
      }
      return;
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : "Live provider unavailable.";
    console.warn(`Live provider unavailable for ${session.id}. Falling back to demo provider. ${message}`);
  }

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
      payload: {
        message: "Measurement is temporarily unavailable. Please try again later."
      }
    });
  }
}

export function createSession(params: {
  target: string;
  mode: TraceMode;
  visitor?: VisitorContext;
}) {
  cleanupExpiredSessions();
  enforceSessionLimit();

  const session: Session = {
    id: nanoid(10),
    target: params.target,
    mode: params.mode,
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
