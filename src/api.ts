import type {
  CreateMeasurementRequest,
  CreateMeasurementResponse,
  MeasurementEvent
} from "../shared/types";

export async function createMeasurement(
  payload: CreateMeasurementRequest
): Promise<CreateMeasurementResponse> {
  const response = await fetch("/api/measurements", {
    method: "POST",
    headers: {
      "content-type": "application/json"
    },
    body: JSON.stringify(payload)
  });

  const data = await response.json();

  if (!response.ok) {
    throw new Error(data.error ?? "Unable to start measurement.");
  }

  return data as CreateMeasurementResponse;
}

export function openMeasurementEvents(
  id: string,
  onEvent: (event: MeasurementEvent) => void,
  onError: (message: string) => void
) {
  const source = new EventSource(`/api/measurements/${id}/events`);
  const eventTypes: MeasurementEvent["type"][] = [
    "measurement_started",
    "hop_result",
    "metric_update",
    "measurement_finished",
    "error"
  ];

  for (const eventType of eventTypes) {
    source.addEventListener(eventType, (message) => {
      const parsed = JSON.parse((message as MessageEvent).data) as MeasurementEvent;
      onEvent(parsed);
    });
  }

  source.onerror = () => {
    onError("The live event stream disconnected.");
  };

  return () => source.close();
}
