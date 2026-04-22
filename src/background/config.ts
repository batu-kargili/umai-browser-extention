import type { ManagedConfig, RuntimeConfig, RuntimeState } from "../shared/types";

const DEFAULT_ALLOWED_DOMAINS = [
  "chatgpt.com",
  "chat.openai.com",
  "gemini.google.com",
  "claude.ai"
];

const DEVICE_ID_KEY = "umai_device_id_v1";
const LOCAL_DEV_CONFIG_KEY = "umai_dev_config_v1";
const DEFAULT_CONTROL_CENTER_URL = "https://duvarai-controlcenter-442107147924.europe-west3.run.app";
const ENABLE_BUILTIN_DUMMY_CONFIG = false;

const BUILTIN_DUMMY_CONFIG: ManagedConfig = {
  tenantId: "00000000-0000-0000-0000-000000000001",
  environment: "stage",
  ingestBaseUrl: "http://localhost:8080",
  policyUrl: "http://localhost:8080/v1/ext/policy",
  controlCenterUrl: DEFAULT_CONTROL_CENTER_URL,
  deviceToken: "dummy-device-token",
  captureMode: "metadata_only",
  retentionLocalDays: 7,
  debug: true,
  allowedDomains: DEFAULT_ALLOWED_DOMAINS
};

let state: RuntimeState = {
  configured: false,
  issues: ["Configuration not loaded yet."]
};

let initialized = false;

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function isUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}

function storageLocalGet<T>(key: string): Promise<T | undefined> {
  return new Promise((resolve) => {
    chrome.storage.local.get([key], (result) => {
      resolve(result[key] as T | undefined);
    });
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

function storageManagedGetAll(): Promise<ManagedConfig> {
  return new Promise((resolve) => {
    try {
      chrome.storage.managed.get(null, (result) => {
        if (chrome.runtime.lastError) {
          resolve({});
          return;
        }
        resolve((result ?? {}) as ManagedConfig);
      });
    } catch (_error) {
      resolve({});
    }
  });
}

async function resolveDeviceId(preferred?: string): Promise<string> {
  if (isNonEmptyString(preferred)) {
    return preferred;
  }
  const existing = await storageLocalGet<string>(DEVICE_ID_KEY);
  if (isNonEmptyString(existing)) {
    return existing;
  }
  const next = crypto.randomUUID();
  await storageLocalSet({ [DEVICE_ID_KEY]: next });
  return next;
}

async function validateManagedConfig(raw: ManagedConfig): Promise<RuntimeState> {
  const issues: string[] = [];

  const tenantId = isNonEmptyString(raw.tenantId) ? raw.tenantId.trim() : "";
  const environment = raw.environment === "prod" || raw.environment === "stage" ? raw.environment : undefined;
  const ingestBaseUrl = isNonEmptyString(raw.ingestBaseUrl) ? raw.ingestBaseUrl.trim() : "";
  const policyUrl = isNonEmptyString(raw.policyUrl) ? raw.policyUrl.trim() : "";
  const controlCenterUrl = isNonEmptyString(raw.controlCenterUrl)
    ? raw.controlCenterUrl.trim()
    : DEFAULT_CONTROL_CENTER_URL;
  const userEmail = isNonEmptyString(raw.userEmail) ? raw.userEmail.trim() : undefined;
  const userIdpSubject = isNonEmptyString(raw.userIdpSubject)
    ? raw.userIdpSubject.trim()
    : undefined;
  const userDisplayName = isNonEmptyString(raw.userDisplayName)
    ? raw.userDisplayName.trim()
    : undefined;
  const deviceToken = isNonEmptyString(raw.deviceToken) ? raw.deviceToken.trim() : "";
  const captureMode = raw.captureMode === "full_content" ? "full_content" : "metadata_only";
  const retentionLocalDays =
    typeof raw.retentionLocalDays === "number" && raw.retentionLocalDays > 0 ? raw.retentionLocalDays : 7;
  const debug = raw.debug === true;
  const allowedDomains =
    Array.isArray(raw.allowedDomains) && raw.allowedDomains.length > 0
      ? raw.allowedDomains
      : DEFAULT_ALLOWED_DOMAINS;
  const breakGlass = raw.breakGlass;

  if (!tenantId) issues.push("tenantId is required.");
  if (tenantId && !isUuid(tenantId)) {
    issues.push("tenantId must be a UUID.");
  }
  if (!environment) issues.push("environment must be prod or stage.");
  if (!ingestBaseUrl) issues.push("ingestBaseUrl is required.");
  if (!policyUrl) issues.push("policyUrl is required.");
  try {
    new URL(controlCenterUrl);
  } catch (_error) {
    issues.push("controlCenterUrl must be a valid URL.");
  }
  if (!deviceToken) issues.push("deviceToken is required.");

  const deviceId = await resolveDeviceId(raw.deviceId);

  if (issues.length > 0) {
    return { configured: false, issues };
  }

  const config: RuntimeConfig = {
    tenantId,
    environment: environment as "prod" | "stage",
    ingestBaseUrl,
    policyUrl,
    controlCenterUrl,
    userEmail,
    userIdpSubject,
    userDisplayName,
    deviceToken,
    deviceId,
    captureMode,
    retentionLocalDays,
    debug,
    allowedDomains,
    breakGlass
  };

  return {
    configured: true,
    issues: [],
    config
  };
}

export async function refreshRuntimeConfig(): Promise<RuntimeState> {
  const managed = await storageManagedGetAll();
  const managedState = await validateManagedConfig(managed);
  if (managedState.configured) {
    state = managedState;
    return state;
  }

  const localFallback = await storageLocalGet<ManagedConfig>(LOCAL_DEV_CONFIG_KEY);
  if (localFallback) {
    const localState = await validateManagedConfig(localFallback);
    if (localState.configured) {
      state = {
        ...localState,
        issues: ["Using local dev fallback config from chrome.storage.local."]
      };
      return state;
    }
  }

  if (ENABLE_BUILTIN_DUMMY_CONFIG) {
    const dummyState = await validateManagedConfig(BUILTIN_DUMMY_CONFIG);
    if (dummyState.configured) {
      state = {
        ...dummyState,
        issues: ["Using built-in dummy config. Replace with managed policy for production."]
      };
      return state;
    }
  }

  state = managedState;
  return state;
}

export function getRuntimeState(): RuntimeState {
  return state;
}

export function isUrlAllowed(url: string): boolean {
  const urlObj = new URL(url);
  const hostname = urlObj.hostname.toLowerCase();
  const allowedDomains = state.configured ? state.config?.allowedDomains ?? DEFAULT_ALLOWED_DOMAINS : DEFAULT_ALLOWED_DOMAINS;
  return allowedDomains.some((domain) => hostname === domain || hostname.endsWith(`.${domain}`));
}

export async function initConfigModule(): Promise<RuntimeState> {
  if (!initialized) {
    initialized = true;
    chrome.storage.onChanged.addListener((changes, areaName) => {
      const managedChanged =
        areaName === "managed" &&
        (changes.tenantId ||
          changes.environment ||
          changes.policyUrl ||
          changes.controlCenterUrl ||
          changes.userEmail ||
          changes.userIdpSubject ||
          changes.userDisplayName ||
          changes.ingestBaseUrl ||
          changes.deviceToken);
      const localFallbackChanged = areaName === "local" && changes[LOCAL_DEV_CONFIG_KEY];
      if (managedChanged || localFallbackChanged) {
        void refreshRuntimeConfig();
      }
    });
  }
  return refreshRuntimeConfig();
}

export const LOCAL_DEV_CONFIG_STORAGE_KEY = LOCAL_DEV_CONFIG_KEY;

export async function setLocalDevConfig(raw: ManagedConfig): Promise<RuntimeState> {
  await storageLocalSet({ [LOCAL_DEV_CONFIG_KEY]: raw });
  return refreshRuntimeConfig();
}

export async function clearLocalDevConfig(): Promise<RuntimeState> {
  await storageLocalRemove(LOCAL_DEV_CONFIG_KEY);
  return refreshRuntimeConfig();
}
