import { hashObjectHex } from "../shared/hash";
import type { BaseEvent, CaptureMode, EventType, RuntimeConfig, SiteId } from "../shared/types";

const LAST_EVENT_HASH_KEY = "umai_last_event_hash_v1";

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

function clonePayload(payload: Record<string, unknown>): Record<string, unknown> {
  return JSON.parse(JSON.stringify(payload));
}

export async function applyCaptureMode(
  payload: Record<string, unknown>,
  captureMode: CaptureMode,
  textFields: string[]
): Promise<Record<string, unknown>> {
  const next = clonePayload(payload);
  for (const key of textFields) {
    const value = next[key];
    if (typeof value !== "string") {
      continue;
    }
    if (captureMode === "full_content") {
      continue;
    }
    next[`${key}_len`] = value.length;
    next[`${key}_hash`] = await hashObjectHex({ text: value });
    delete next[key];
  }
  return next;
}

export async function buildEventEnvelope(input: {
  config: RuntimeConfig;
  eventType: EventType;
  site: SiteId | "extension";
  url: string;
  tabId?: number;
  userEmail?: string;
  userIdpSubject?: string;
  userDisplayName?: string;
  payload: Record<string, unknown>;
}): Promise<BaseEvent> {
  const prevHash = (await storageLocalGet<string>(LAST_EVENT_HASH_KEY)) ?? null;
  const eventId = crypto.randomUUID();
  const effectiveUserEmail = input.userEmail ?? input.config.userEmail;
  const effectiveUserIdpSubject = input.userIdpSubject ?? input.config.userIdpSubject;
  const effectiveUserDisplayName = input.userDisplayName ?? input.config.userDisplayName;
  const payload = clonePayload(input.payload);
  if (effectiveUserDisplayName && !payload.user_name) {
    payload.user_name = effectiveUserDisplayName;
  }

  const provisional = {
    event_id: eventId,
    event_type: input.eventType,
    tenant_id: input.config.tenantId,
    user: {
      user_email: effectiveUserEmail,
      user_idp_subject: effectiveUserIdpSubject
    },
    device: {
      device_id: input.config.deviceId
    },
    app: {
      site: input.site,
      url: input.url,
      tab_id: input.tabId
    },
    timestamps: {
      captured_at_ms: Date.now()
    },
    chain: {
      prev_event_hash: prevHash,
      event_hash: ""
    },
    payload
  };

  const eventHash = await hashObjectHex(provisional);

  const event: BaseEvent = {
    ...provisional,
    chain: {
      prev_event_hash: prevHash,
      event_hash: eventHash
    }
  };

  await storageLocalSet({ [LAST_EVENT_HASH_KEY]: eventHash });
  return event;
}

export async function resetEventChain(): Promise<void> {
  await storageLocalRemove(LAST_EVENT_HASH_KEY);
}
