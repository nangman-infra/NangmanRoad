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
  events: MeasurementEvent[];
  listeners: Set<Listener>;
}

const sessions = new Map<string, Session>();

function publish(session: Session, event: MeasurementEvent) {
  session.events.push(event);

  if (event.type === "measurement_started") {
    session.status = "running";
  }

  if (event.type === "measurement_finished") {
    session.status = "finished";
  }

  if (event.type === "error") {
    session.status = "error";
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
    publish(session, {
      type: "error",
      payload: {
        message: `Live provider unavailable. Falling back to demo provider. ${message}`
      }
    });
  }

  for await (const event of runDemoMeasurement({
    id: session.id,
    target: session.target,
    mode: session.mode,
    visitor
  })) {
    publish(session, event);
  }
}

export function createSession(params: {
  target: string;
  mode: TraceMode;
  visitor?: VisitorContext;
}) {
  const session: Session = {
    id: nanoid(10),
    target: params.target,
    mode: params.mode,
    status: "starting",
    events: [],
    listeners: new Set()
  };

  sessions.set(session.id, session);
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
