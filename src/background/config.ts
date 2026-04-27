import type {
  BrowserSecurityConfig,
  BrowserSecurityManagedConfig,
  FileInspectionConfig,
  FileInspectionManagedConfig,
  ManagedConfig,
  RuntimeConfig,
  RuntimeState
} from "../shared/types";

const DEFAULT_ALLOWED_DOMAINS = [
  "chatgpt.com",
  "chat.openai.com",
  "gemini.google.com",
  "claude.ai"
];

const DEFAULT_SHADOW_AI_DOMAINS = [
  "copilot.microsoft.com",
  "perplexity.ai",
  "poe.com",
  "chat.deepseek.com",
  "meta.ai",
  "grok.com"
];

const DEFAULT_FILE_INSPECTION: FileInspectionConfig = {
  enabled: true,
  maxFileBytes: 26214400,
  maxExtractedChars: 250000,
  incompleteAction: "step_up",
  supportedTypes: ["txt", "csv", "xlsx", "docx"]
};

const DEVICE_ID_KEY = "umai_device_id_v1";
const LOCAL_DEV_CONFIG_KEY = "umai_dev_config_v1";
const BOOTSTRAP_STATE_KEY = "umai_bootstrap_state_v1";
const DEFAULT_CONTROL_CENTER_URL = "https://pocttconsole.umaisolutions.com";
const DEFAULT_BOOTSTRAP_TIMEOUT_MS = 15000;
const ENABLE_BUILTIN_DUMMY_CONFIG = false;

const BUILTIN_DUMMY_CONFIG: ManagedConfig = {
  tenantId: "00000000-0000-0000-0000-000000000001",
  environment: "stage",
  ingestBaseUrl: "http://localhost:8080/api",
  eventsUrl: "http://localhost:8080/api/v1/ext/events",
  policyUrl: "http://localhost:8080/api/v1/ext/policy",
  evaluateUrl: "http://localhost:8080/api/v1/ext/evaluate",
  evaluationMode: "local",
  bootstrapUrl: "http://localhost:8080/api/v1/ext/bootstrap",
  bootstrapToken: "dummy-bootstrap-token",
  controlCenterUrl: DEFAULT_CONTROL_CENTER_URL,
  captureMode: "metadata_only",
  retentionLocalDays: 7,
  debug: true,
  allowedDomains: DEFAULT_ALLOWED_DOMAINS,
  browserSecurity: {
    enabled: true,
    mode: "enforce",
    shadowAiDomains: DEFAULT_SHADOW_AI_DOMAINS
  }
};

interface BootstrapState {
  cacheKey: string;
  deviceToken: string;
  expiresAt: number;
}

interface BootstrapResponse {
  tenant_id: string;
  device_id: string;
  device_token: string;
  token_type: string;
  expires_at: number;
  audience: string;
}

interface BrowserProfileIdentity {
  email?: string;
  id?: string;
  displayName?: string;
}

let state: RuntimeState = {
  configured: false,
  issues: ["Configuration not loaded yet."]
};

let initialized = false;

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function isUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
    value
  );
}

function normalizeStringArray(value: unknown, fallback: string[]): string[] {
  if (!Array.isArray(value)) {
    return [...fallback];
  }
  const next = value
    .filter((entry): entry is string => isNonEmptyString(entry))
    .map((entry) => entry.trim().toLowerCase());
  return next.length > 0 ? next : [...fallback];
}

function getDefaultBrowserSecurity(): BrowserSecurityConfig {
  return {
    enabled: false,
    mode: "enforce",
    shadowAiDomains: [...DEFAULT_SHADOW_AI_DOMAINS]
  };
}

function normalizeBrowserSecurity(raw: BrowserSecurityManagedConfig | undefined): BrowserSecurityConfig {
  const defaults = getDefaultBrowserSecurity();
  return {
    enabled: raw?.enabled === true,
    mode: raw?.mode === "audit" ? "audit" : defaults.mode,
    shadowAiDomains: normalizeStringArray(raw?.shadowAiDomains, defaults.shadowAiDomains)
  };
}

function normalizeFileInspection(raw: FileInspectionManagedConfig | undefined): FileInspectionConfig {
  const supportedTypes = normalizeStringArray(raw?.supportedTypes, DEFAULT_FILE_INSPECTION.supportedTypes)
    .map((entry) => entry.replace(/^\./, ""))
    .filter((entry) => entry.length > 0);
  const incompleteAction =
    raw?.incompleteAction === "block" || raw?.incompleteAction === "warn"
      ? raw.incompleteAction
      : DEFAULT_FILE_INSPECTION.incompleteAction;
  return {
    enabled: raw?.enabled !== false,
    maxFileBytes:
      typeof raw?.maxFileBytes === "number" && raw.maxFileBytes > 0
        ? Math.floor(raw.maxFileBytes)
        : DEFAULT_FILE_INSPECTION.maxFileBytes,
    maxExtractedChars:
      typeof raw?.maxExtractedChars === "number" && raw.maxExtractedChars > 0
        ? Math.floor(raw.maxExtractedChars)
        : DEFAULT_FILE_INSPECTION.maxExtractedChars,
    incompleteAction,
    supportedTypes: supportedTypes.length > 0 ? supportedTypes : [...DEFAULT_FILE_INSPECTION.supportedTypes]
  };
}

function displayNameFromEmail(email: string): string | undefined {
  const localPart = email.split("@")[0]?.trim();
  if (!localPart) {
    return undefined;
  }
  const words = localPart
    .replace(/[._-]+/g, " ")
    .split(/\s+/)
    .filter(Boolean);
  if (words.length === 0) {
    return undefined;
  }
  return words
    .map((word) => `${word.charAt(0).toUpperCase()}${word.slice(1)}`)
    .join(" ");
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

async function getBrowserProfileIdentity(): Promise<BrowserProfileIdentity> {
  try {
    if (!chrome.identity?.getProfileUserInfo) {
      return {};
    }
    const profile = await chrome.identity.getProfileUserInfo({ accountStatus: "ANY" });
    const email = isNonEmptyString(profile.email) ? profile.email.trim() : undefined;
    const id = isNonEmptyString(profile.id) ? profile.id.trim() : undefined;
    return {
      email,
      id,
      displayName: email ? displayNameFromEmail(email) : undefined
    };
  } catch (_error) {
    return {};
  }
}

async function resolveDeviceId(preferred?: string): Promise<string> {
  if (isNonEmptyString(preferred)) {
    return preferred.trim();
  }
  const existing = await storageLocalGet<string>(DEVICE_ID_KEY);
  if (isNonEmptyString(existing)) {
    return existing;
  }
  const next = crypto.randomUUID();
  await storageLocalSet({ [DEVICE_ID_KEY]: next });
  return next;
}

async function clearBootstrapState(): Promise<void> {
  await storageLocalRemove(BOOTSTRAP_STATE_KEY);
}

function buildBootstrapCacheKey(raw: ManagedConfig, tenantId: string, deviceId: string): string {
  const bootstrapUrl = isNonEmptyString(raw.bootstrapUrl) ? raw.bootstrapUrl.trim() : "";
  const bootstrapToken = isNonEmptyString(raw.bootstrapToken) ? raw.bootstrapToken.trim() : "";
  return `${tenantId}|${deviceId}|${bootstrapUrl}|${bootstrapToken}`;
}

function isBootstrapResponse(value: unknown): value is BootstrapResponse {
  if (!value || typeof value !== "object") {
    return false;
  }
  const casted = value as BootstrapResponse;
  return (
    isNonEmptyString(casted.tenant_id) &&
    isNonEmptyString(casted.device_id) &&
    isNonEmptyString(casted.device_token) &&
    typeof casted.expires_at === "number"
  );
}

async function fetchBootstrapDeviceToken(
  raw: ManagedConfig,
  tenantId: string,
  deviceId: string
): Promise<string> {
  const bootstrapUrl = isNonEmptyString(raw.bootstrapUrl) ? raw.bootstrapUrl.trim() : "";
  const bootstrapToken = isNonEmptyString(raw.bootstrapToken) ? raw.bootstrapToken.trim() : "";
  if (!bootstrapUrl || !bootstrapToken) {
    return "";
  }

  const cacheKey = buildBootstrapCacheKey(raw, tenantId, deviceId);
  const cached = await storageLocalGet<BootstrapState>(BOOTSTRAP_STATE_KEY);
  const now = Math.floor(Date.now() / 1000);
  if (
    cached &&
    cached.cacheKey === cacheKey &&
    isNonEmptyString(cached.deviceToken) &&
    typeof cached.expiresAt === "number" &&
    cached.expiresAt > now + 60
  ) {
    return cached.deviceToken;
  }

  const response = await fetch(bootstrapUrl, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${bootstrapToken}`,
      "X-Tenant-Id": tenantId
    },
    body: JSON.stringify({
      tenant_id: tenantId,
      device_id: deviceId,
      extension_id: chrome.runtime.id
    }),
    cache: "no-store",
    credentials: "omit"
  });

  if (!response.ok) {
    let reason = `Bootstrap failed (${response.status}).`;
    try {
      const errorBody = (await response.json()) as { error?: string; message?: string };
      reason = errorBody.error || errorBody.message || reason;
    } catch (_error) {
      // Ignore parse failures and surface the HTTP status-based message.
    }
    throw new Error(reason);
  }

  const body = (await response.json()) as unknown;
  if (!isBootstrapResponse(body)) {
    throw new Error("Bootstrap response is invalid.");
  }

  await storageLocalSet({
    [BOOTSTRAP_STATE_KEY]: {
      cacheKey,
      deviceToken: body.device_token,
      expiresAt: body.expires_at
    } satisfies BootstrapState
  });

  return body.device_token;
}

async function resolveDeviceToken(
  raw: ManagedConfig,
  tenantId: string,
  deviceId: string
): Promise<string> {
  const explicit = isNonEmptyString(raw.deviceToken) ? raw.deviceToken.trim() : "";
  if (explicit) {
    return explicit;
  }
  return fetchBootstrapDeviceToken(raw, tenantId, deviceId);
}

async function validateManagedConfig(raw: ManagedConfig): Promise<RuntimeState> {
  const issues: string[] = [];

  const tenantId = isNonEmptyString(raw.tenantId) ? raw.tenantId.trim() : "";
  const environment =
    raw.environment === "prod" || raw.environment === "stage" ? raw.environment : undefined;
  const ingestBaseUrl = isNonEmptyString(raw.ingestBaseUrl) ? raw.ingestBaseUrl.trim() : "";
  const eventsUrl = isNonEmptyString(raw.eventsUrl) ? raw.eventsUrl.trim() : "";
  const policyUrl = isNonEmptyString(raw.policyUrl) ? raw.policyUrl.trim() : "";
  const evaluateUrl = isNonEmptyString(raw.evaluateUrl) ? raw.evaluateUrl.trim() : "";
  const evaluationMode = raw.evaluationMode === "server" ? "server" : "local";
  const bootstrapUrl = isNonEmptyString(raw.bootstrapUrl) ? raw.bootstrapUrl.trim() : "";
  const bootstrapToken = isNonEmptyString(raw.bootstrapToken) ? raw.bootstrapToken.trim() : "";
  const controlCenterUrl = isNonEmptyString(raw.controlCenterUrl)
    ? raw.controlCenterUrl.trim()
    : DEFAULT_CONTROL_CENTER_URL;
  const profileIdentity = await getBrowserProfileIdentity();
  const userEmail = isNonEmptyString(raw.userEmail)
    ? raw.userEmail.trim()
    : profileIdentity.email;
  const userIdpSubject = isNonEmptyString(raw.userIdpSubject)
    ? raw.userIdpSubject.trim()
    : profileIdentity.id;
  const userDisplayName = isNonEmptyString(raw.userDisplayName)
    ? raw.userDisplayName.trim()
    : profileIdentity.displayName;
  const captureMode = raw.captureMode === "full_content" ? "full_content" : "metadata_only";
  const retentionLocalDays =
    typeof raw.retentionLocalDays === "number" && raw.retentionLocalDays > 0
      ? raw.retentionLocalDays
      : 7;
  const debug = raw.debug === true;
  const allowedDomains = normalizeStringArray(raw.allowedDomains, DEFAULT_ALLOWED_DOMAINS);
  const browserSecurity = normalizeBrowserSecurity(raw.browserSecurity);
  const fileInspection = normalizeFileInspection(raw.fileInspection);
  const breakGlass = raw.breakGlass;

  if (!tenantId) {
    issues.push("tenantId is required.");
  } else if (!isUuid(tenantId)) {
    issues.push("tenantId must be a UUID.");
  }
  if (!environment) {
    issues.push("environment must be prod or stage.");
  }
  if (!ingestBaseUrl) {
    issues.push("ingestBaseUrl is required.");
  }
  if (eventsUrl) {
    try {
      new URL(eventsUrl);
    } catch (_error) {
      issues.push("eventsUrl must be a valid URL.");
    }
  }
  if (!policyUrl) {
    issues.push("policyUrl is required.");
  }
  if (evaluationMode === "server") {
    if (!evaluateUrl) {
      issues.push("evaluateUrl is required when evaluationMode is server.");
    } else {
      try {
        new URL(evaluateUrl);
      } catch (_error) {
        issues.push("evaluateUrl must be a valid URL.");
      }
    }
  }
  if (bootstrapUrl || bootstrapToken) {
    if (!bootstrapUrl || !bootstrapToken) {
      issues.push("bootstrapUrl and bootstrapToken are required together.");
    } else {
      try {
        new URL(bootstrapUrl);
      } catch (_error) {
        issues.push("bootstrapUrl must be a valid URL.");
      }
    }
  }
  try {
    new URL(controlCenterUrl);
  } catch (_error) {
    issues.push("controlCenterUrl must be a valid URL.");
  }

  const deviceId = await resolveDeviceId(raw.deviceId);
  let deviceToken = "";
  if (issues.length === 0) {
    try {
      deviceToken = await Promise.race([
        resolveDeviceToken(raw, tenantId, deviceId),
        new Promise<string>((_, reject) => {
          setTimeout(() => reject(new Error("Bootstrap timed out.")), DEFAULT_BOOTSTRAP_TIMEOUT_MS);
        })
      ]);
    } catch (error) {
      const message =
        error instanceof Error ? error.message : "Failed to bootstrap extension device token.";
      issues.push(message);
    }
  }

  if (!deviceToken) {
    issues.push("deviceToken or bootstrapUrl/bootstrapToken is required.");
  }

  if (issues.length > 0) {
    return { configured: false, issues };
  }

  const config: RuntimeConfig = {
    tenantId,
    environment: environment as "prod" | "stage",
    ingestBaseUrl,
    eventsUrl: eventsUrl || undefined,
    policyUrl,
    evaluateUrl: evaluateUrl || undefined,
    evaluationMode,
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
    browserSecurity,
    fileInspection,
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

export function getBrowserSecurityConfig(): BrowserSecurityConfig {
  return state.configured && state.config
    ? state.config.browserSecurity
    : getDefaultBrowserSecurity();
}

export function isUrlAllowed(url: string): boolean {
  const urlObj = new URL(url);
  const hostname = urlObj.hostname.toLowerCase();
  const allowedDomains = state.configured
    ? state.config?.allowedDomains ?? DEFAULT_ALLOWED_DOMAINS
    : DEFAULT_ALLOWED_DOMAINS;
  return allowedDomains.some(
    (domain) => hostname === domain || hostname.endsWith(`.${domain}`)
  );
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
          changes.eventsUrl ||
          changes.evaluateUrl ||
          changes.evaluationMode ||
          changes.bootstrapUrl ||
          changes.bootstrapToken ||
          changes.controlCenterUrl ||
          changes.userEmail ||
          changes.userIdpSubject ||
          changes.userDisplayName ||
          changes.ingestBaseUrl ||
          changes.deviceToken ||
          changes.deviceId ||
          changes.captureMode ||
          changes.retentionLocalDays ||
          changes.debug ||
          changes.allowedDomains ||
          changes.browserSecurity ||
          changes.fileInspection ||
          changes.breakGlass);
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
  await clearBootstrapState();
  await storageLocalSet({ [LOCAL_DEV_CONFIG_KEY]: raw });
  return refreshRuntimeConfig();
}

export async function clearLocalDevConfig(): Promise<RuntimeState> {
  await clearBootstrapState();
  await storageLocalRemove(LOCAL_DEV_CONFIG_KEY);
  return refreshRuntimeConfig();
}
