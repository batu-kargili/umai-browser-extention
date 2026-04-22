import { buildAuthHeaders } from "./auth";
import { getRuntimeState } from "./config";
import { ackEvents, compactQueue, markAttempted, takeBatch } from "./queue";

let started = false;
let isFlushing = false;
let backoffMs = 2000;

function computeEndpoint(baseUrl: string): string {
  const trimmed = baseUrl.replace(/\/+$/, "");
  if (trimmed.endsWith("/v1/ext/events")) {
    return trimmed;
  }
  return `${trimmed}/v1/ext/events`;
}

function scheduleNext(): void {
  const jitter = Math.floor(Math.random() * 350);
  setTimeout(() => {
    void flushQueue();
  }, backoffMs + jitter);
}

export async function flushQueue(): Promise<void> {
  if (isFlushing) {
    return;
  }
  isFlushing = true;
  try {
    const runtimeState = getRuntimeState();
    if (!runtimeState.configured || !runtimeState.config) {
      backoffMs = Math.min(backoffMs * 2, 60000);
      return;
    }

    const config = runtimeState.config;
    await compactQueue(config.retentionLocalDays);

    const batch = await takeBatch(25);
    if (batch.length === 0) {
      backoffMs = 5000;
      return;
    }

    const eventIds = batch.map((item) => item.event.event_id);
    await markAttempted(eventIds);

    const response = await fetch(computeEndpoint(config.ingestBaseUrl), {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...buildAuthHeaders(config)
      },
      body: JSON.stringify({
        tenant_id: config.tenantId,
        device_id: config.deviceId,
        events: batch.map((item) => item.event)
      })
    });

    if (!response.ok) {
      if (response.status === 422) {
        // Validation failures can be caused by stale/legacy queued envelopes.
        // Drop this batch to unblock subsequent valid events.
        await ackEvents(eventIds);
        backoffMs = 2000;
        return;
      }
      backoffMs = Math.min(backoffMs * 2, 60000);
      return;
    }

    await ackEvents(eventIds);
    backoffMs = 2000;
  } catch (_error) {
    backoffMs = Math.min(backoffMs * 2, 60000);
  } finally {
    isFlushing = false;
    scheduleNext();
  }
}

export function startUploader(): void {
  if (started) {
    return;
  }
  started = true;
  scheduleNext();
}
