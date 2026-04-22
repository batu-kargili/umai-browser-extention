import type { BaseEvent, QueueItem } from "../shared/types";

const QUEUE_KEY = "umai_event_queue_v1";

function storageLocalGet<T>(key: string): Promise<T | undefined> {
  return new Promise((resolve) => {
    chrome.storage.local.get([key], (result) => resolve(result[key] as T | undefined));
  });
}

function storageLocalSet(values: Record<string, unknown>): Promise<void> {
  return new Promise((resolve) => {
    chrome.storage.local.set(values, () => resolve());
  });
}

function storageLocalRemove(key: string): Promise<void> {
  return new Promise((resolve) => {
    chrome.storage.local.remove([key], () => resolve());
  });
}

let queueLock = Promise.resolve();

async function withLock<T>(fn: () => Promise<T>): Promise<T> {
  const previous = queueLock;
  let release: () => void = () => undefined;
  queueLock = new Promise<void>((resolve) => {
    release = resolve;
  });
  await previous;
  try {
    return await fn();
  } finally {
    release();
  }
}

async function readQueue(): Promise<QueueItem[]> {
  const existing = await storageLocalGet<QueueItem[]>(QUEUE_KEY);
  if (!Array.isArray(existing)) {
    return [];
  }
  return existing;
}

async function writeQueue(next: QueueItem[]): Promise<void> {
  await storageLocalSet({ [QUEUE_KEY]: next });
}

export async function enqueueEvent(event: BaseEvent): Promise<void> {
  await withLock(async () => {
    const queue = await readQueue();
    queue.push({
      createdAtMs: Date.now(),
      attemptCount: 0,
      event
    });
    await writeQueue(queue);
  });
}

export async function markAttempted(eventIds: string[]): Promise<void> {
  if (eventIds.length === 0) {
    return;
  }
  await withLock(async () => {
    const queue = await readQueue();
    const idSet = new Set(eventIds);
    const next = queue.map((item) =>
      idSet.has(item.event.event_id)
        ? {
            ...item,
            attemptCount: item.attemptCount + 1
          }
        : item
    );
    await writeQueue(next);
  });
}

export async function ackEvents(eventIds: string[]): Promise<void> {
  if (eventIds.length === 0) {
    return;
  }
  await withLock(async () => {
    const idSet = new Set(eventIds);
    const queue = await readQueue();
    const next = queue.filter((item) => !idSet.has(item.event.event_id));
    await writeQueue(next);
  });
}

export async function takeBatch(limit = 25): Promise<QueueItem[]> {
  return withLock(async () => {
    const queue = await readQueue();
    return queue.slice(0, limit);
  });
}

export async function compactQueue(retentionDays: number): Promise<void> {
  const cutoff = Date.now() - retentionDays * 24 * 60 * 60 * 1000;
  await withLock(async () => {
    const queue = await readQueue();
    const next = queue.filter((item) => item.createdAtMs >= cutoff);
    if (next.length !== queue.length) {
      await writeQueue(next);
    }
  });
}

export async function queueSize(): Promise<number> {
  return withLock(async () => {
    const queue = await readQueue();
    return queue.length;
  });
}

export async function clearQueue(): Promise<void> {
  await withLock(async () => {
    await storageLocalRemove(QUEUE_KEY);
  });
}
