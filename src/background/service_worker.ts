import {
  initConfigModule,
  getRuntimeState,
  isUrlAllowed,
  refreshRuntimeConfig,
  setLocalDevConfig,
  clearLocalDevConfig
} from "./config";
import { buildAuthHeaders } from "./auth";
import { enforceBrowserSecurityAcrossTabs, initBrowserSecurityGuardrails } from "./browser_security";
import { initPolicyCache, refreshPolicyPack, getPolicyPack } from "./policy_cache";
import { startUploader, flushQueue } from "./uploader";
import { clearQueue, enqueueEvent } from "./queue";
import { applyCaptureMode, buildEventEnvelope, resetEventChain } from "./events";
import { scanTextForDlp } from "../shared/dlp";
import { evaluatePromptPolicy } from "../shared/policy_engine";
import type {
  AdapterHealthRequest,
  AttachmentManifest,
  ContentToBackgroundMessage,
  Decision,
  DlpResult,
  EvalPromptRequest,
  EvalPromptResponse,
  ManagedConfig,
  PromptSubmittedRequest,
  ResponseFinalRequest,
  RuntimeState
} from "../shared/types";

const POLICY_REFRESH_ALARM = "umai_policy_refresh";
const QUEUE_FLUSH_ALARM = "umai_queue_flush";
const CONTROL_CENTER_CONNECT_PATH = "/extension/connect";
const TRUSTED_CONTROL_CENTER_ORIGINS = new Set<string>([
  "http://localhost:3000",
  "https://pocttconsole.umaisolutions.com",
  "https://umai-controlcenter-442107147924.europe-west3.run.app",
  "https://umai-controlcenter-mhkvrwuj2q-ey.a.run.app",
  "https://duvarai-controlcenter-442107147924.europe-west3.run.app",
  "https://duvarai-controlcenter-mhkvrwuj2q-ey.a.run.app"
]);
const CAPTURE_TAB_URLS = [
  "https://chatgpt.com/*",
  "https://chat.openai.com/*",
  "https://gemini.google.com/*",
  "https://claude.ai/*"
];

type ExternalConnectMessage =
  | { type: "UMAI_PING" | "DUVARAI_PING" }
  | { type: "UMAI_CONNECT" | "DUVARAI_CONNECT"; payload: ManagedConfig }
  | { type: "UMAI_DISCONNECT" | "DUVARAI_DISCONNECT" };

function isTrustedExternalSender(sender: chrome.runtime.MessageSender): boolean {
  if (!sender.url) {
    return false;
  }
  try {
    const senderUrl = new URL(sender.url);
    const origin = senderUrl.origin.toLowerCase();
    const trustedOrigin = TRUSTED_CONTROL_CENTER_ORIGINS.has(origin);
    const validPath =
      senderUrl.pathname === CONTROL_CENTER_CONNECT_PATH ||
      senderUrl.pathname.startsWith(`${CONTROL_CENTER_CONNECT_PATH}/`);
    return trustedOrigin && validPath;
  } catch (_error) {
    return false;
  }
}

function sanitizedRuntimeState(nextState: RuntimeState): RuntimeState {
  if (!nextState.configured || !nextState.config) {
    return nextState;
  }
  return {
    configured: true,
    issues: [],
    config: {
      ...nextState.config,
      deviceToken: "hidden"
    }
  };
}

function queryCaptureTabs(): Promise<chrome.tabs.Tab[]> {
  return new Promise((resolve) => {
    chrome.tabs.query({ url: CAPTURE_TAB_URLS }, (tabs) => {
      resolve(Array.isArray(tabs) ? tabs : []);
    });
  });
}

function reloadTab(tabId: number): Promise<void> {
  return new Promise((resolve) => {
    chrome.tabs.reload(tabId, () => {
      resolve();
    });
  });
}

async function refreshCaptureTabs(): Promise<void> {
  try {
    const tabs = await queryCaptureTabs();
    await Promise.all(
      tabs.map((tab) => (typeof tab.id === "number" ? reloadTab(tab.id) : Promise.resolve()))
    );
  } catch (_error) {
    // Best-effort refresh so open AI tabs pick up the latest content scripts after install/update.
  }
}

async function logPromptAttempted(
  payload: EvalPromptRequest,
  dlpTags: string[],
  riskScore: number
): Promise<void> {
  const runtimeState = getRuntimeState();
  if (!runtimeState.configured || !runtimeState.config) {
    return;
  }
  const protectedPayload = await applyCaptureMode(
    {
      prompt_text: payload.promptText,
      prompt_len: payload.promptText.length,
      attachments: sanitizeAttachmentsForCapture(payload.attachments ?? [], runtimeState.config.captureMode),
      dlp_tags: dlpTags,
      risk_score: riskScore
    },
    runtimeState.config.captureMode,
    ["prompt_text"]
  );
  const event = await buildEventEnvelope({
    config: runtimeState.config,
    eventType: "prompt_attempted",
    site: payload.site,
    url: payload.url,
    tabId: payload.tabId,
    userEmail: payload.userEmail,
    payload: protectedPayload
  });
  await enqueueEvent(event);
}

function sanitizeAttachmentsForCapture(
  attachments: AttachmentManifest[],
  captureMode: "metadata_only" | "full_content"
): Array<Record<string, unknown>> {
  return attachments.map((attachment) => {
    const next: Record<string, unknown> = { ...attachment };
    if (captureMode !== "full_content") {
      delete next.extracted_text;
      delete next.content_b64;
    }
    return next;
  });
}

async function logPolicyDecision(
  payload: EvalPromptRequest,
  decision: EvalPromptResponse["decision"]
): Promise<void> {
  const runtimeState = getRuntimeState();
  if (!runtimeState.configured || !runtimeState.config) {
    return;
  }
  const event = await buildEventEnvelope({
    config: runtimeState.config,
    eventType: "policy_decision",
    site: payload.site,
    url: payload.url,
    tabId: payload.tabId,
    userEmail: payload.userEmail,
    payload: {
      decision: decision.type,
      message: decision.message,
      rules_fired: decision.rulesFired,
      dlp_tags: decision.dlpTags,
      redactions: decision.redactions,
      require_justification: decision.requireJustification,
      min_justification_chars: decision.minJustificationChars
    }
  });
  await enqueueEvent(event);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function stringArray(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.filter((entry): entry is string => typeof entry === "string" && entry.length > 0);
}

function normalizeRedactions(value: unknown): Decision["redactions"] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value
    .filter(isRecord)
    .map((entry) => ({
      start: typeof entry.start === "number" ? entry.start : -1,
      end: typeof entry.end === "number" ? entry.end : -1,
      kind: typeof entry.kind === "string" ? entry.kind : "server"
    }))
    .filter((entry) => entry.start >= 0 && entry.end >= entry.start);
}

function normalizeServerDecision(value: unknown, dlp: DlpResult): Decision | null {
  if (!isRecord(value)) {
    return null;
  }
  const type = value.type;
  if (
    type !== "allow" &&
    type !== "warn" &&
    type !== "block" &&
    type !== "redact" &&
    type !== "justify"
  ) {
    return null;
  }
  const minChars = value.minJustificationChars;
  return {
    type,
    message: typeof value.message === "string" ? value.message : undefined,
    rulesFired: stringArray(value.rulesFired),
    dlpTags: stringArray(value.dlpTags).length > 0 ? stringArray(value.dlpTags) : dlp.tags,
    redactions: normalizeRedactions(value.redactions),
    redactedText: typeof value.redactedText === "string" ? value.redactedText : undefined,
    requireJustification: value.requireJustification === true,
    minJustificationChars: typeof minChars === "number" ? minChars : undefined
  };
}

function serverUnavailableDecision(message: string, dlp: DlpResult): Decision {
  return {
    type: "block",
    message: `UMAI server guardrail evaluation failed closed. ${message}`,
    rulesFired: ["server_guardrail_unreachable"],
    dlpTags: dlp.tags,
    redactions: [],
    requireJustification: false
  };
}

function attachmentIncompleteDecision(
  attachments: AttachmentManifest[],
  dlp: DlpResult,
  action: "step_up" | "block" | "warn"
): Decision | null {
  const tooLarge = attachments.find((attachment) => attachment.inspection_status === "too_large");
  if (tooLarge) {
    return {
      type: "block",
      message: `File ${tooLarge.filename} exceeds the organization file inspection size limit.`,
      rulesFired: ["attachment_too_large"],
      dlpTags: dlp.tags,
      redactions: [],
      requireJustification: false
    };
  }

  const incomplete = attachments.find((attachment) =>
    ["server_required", "pending", "unsupported", "extraction_failed", "truncated"].includes(
      attachment.inspection_status
    )
  );
  if (!incomplete) {
    return null;
  }

  const decisionType = action === "block" ? "block" : action === "warn" ? "warn" : "justify";
  return {
    type: decisionType,
    message: `File ${incomplete.filename} could not be fully inspected before AI submission.`,
    rulesFired: [`attachment_${incomplete.inspection_status}`],
    dlpTags: dlp.tags,
    redactions: [],
    requireJustification: decisionType === "justify",
    minJustificationChars: decisionType === "justify" ? 12 : undefined
  };
}

async function evaluatePromptOnServer(
  payload: EvalPromptRequest,
  dlp: DlpResult
): Promise<Decision> {
  const runtimeState = getRuntimeState();
  const config = runtimeState.config;
  if (!runtimeState.configured || !config || !config.evaluateUrl) {
    throw new Error("Server evaluation is not configured.");
  }

  const response = await fetch(config.evaluateUrl, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...buildAuthHeaders(config)
    },
    body: JSON.stringify({
      tenant_id: config.tenantId,
      site: payload.site,
      url: payload.url,
      tab_id: payload.tabId,
      prompt_text: payload.promptText,
      capture_mode: config.captureMode,
      user: {
        user_email: payload.userEmail ?? config.userEmail,
        user_idp_subject: config.userIdpSubject
      },
      device: {
        device_id: config.deviceId
      },
      attachments: payload.attachments ?? [],
      dlp,
      timeout_ms: 2500,
      allow_llm_calls: true
    }),
    cache: "no-store",
    credentials: "omit"
  });

  const responseBody = (await response.json().catch(() => ({}))) as unknown;
  if (!response.ok) {
    const detail =
      isRecord(responseBody) && typeof responseBody.message === "string"
        ? responseBody.message
        : `HTTP ${response.status}`;
    throw new Error(detail);
  }
  if (!isRecord(responseBody)) {
    throw new Error("Invalid server evaluation response.");
  }
  const decision = normalizeServerDecision(responseBody.decision, dlp);
  if (!decision) {
    throw new Error("Server evaluation decision is invalid.");
  }
  return decision;
}

async function onEvalPrompt(payload: EvalPromptRequest): Promise<EvalPromptResponse> {
  const runtimeState = getRuntimeState();
  if (!isUrlAllowed(payload.url)) {
    return {
      ok: false,
      configured: runtimeState.configured,
      message: "This domain is not allowed by enterprise policy.",
      decision: {
        type: "block",
        message: "Domain not allowed by policy.",
        rulesFired: ["allowlist_domain_check"],
        dlpTags: [],
        redactions: [],
        requireJustification: false
      }
    };
  }

  if (!runtimeState.configured || !runtimeState.config) {
    const missingDetails =
      runtimeState.issues.length > 0
        ? runtimeState.issues.join(" ")
        : "Managed policy or local org connection not available.";
    return {
      ok: false,
      configured: false,
      message: "Extension is not configured. Connect organization from UMAI Control Center.",
      decision: {
        type: "block",
        message: `UMAI extension is not configured. ${missingDetails}`,
        rulesFired: ["managed_config_missing"],
        dlpTags: [],
        redactions: [],
        requireJustification: false
      }
    };
  }

  const dlp = scanTextForDlp(payload.promptText);
  const attachmentText = (payload.attachments ?? [])
    .map((attachment) => attachment.extracted_text ?? "")
    .filter((text) => text.length > 0)
    .join("\n");
  const attachmentDlp = attachmentText ? scanTextForDlp(attachmentText) : undefined;
  const combinedDlp: DlpResult = attachmentDlp
    ? {
        tags: Array.from(new Set([...dlp.tags, ...attachmentDlp.tags])).sort(),
        findings: [...dlp.findings, ...attachmentDlp.findings],
        riskScore: dlp.riskScore + attachmentDlp.riskScore
      }
    : dlp;
  let decision: Decision;
  const localAttachmentDecision = attachmentIncompleteDecision(
    payload.attachments ?? [],
    combinedDlp,
    runtimeState.config.fileInspection.incompleteAction
  );
  if (runtimeState.config.evaluationMode === "server" && !localAttachmentDecision?.rulesFired.includes("attachment_too_large")) {
    try {
      decision = await evaluatePromptOnServer(payload, combinedDlp);
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unknown error.";
      decision = serverUnavailableDecision(message, combinedDlp);
    }
  } else if (localAttachmentDecision) {
    decision = localAttachmentDecision;
  } else {
    decision = evaluatePromptPolicy(`${payload.promptText}\n${attachmentText}`, combinedDlp, getPolicyPack());
    if (attachmentDlp && decision.type === "redact" && attachmentDlp.tags.length > 0) {
      decision = {
        type: "justify",
        message: "An attachment contains sensitive data that cannot be redacted in the browser.",
        rulesFired: [...decision.rulesFired, "attachment_redaction_requires_approval"],
        dlpTags: combinedDlp.tags,
        redactions: [],
        requireJustification: true,
        minJustificationChars: 12
      };
    }
  }

  await logPromptAttempted(payload, combinedDlp.tags, combinedDlp.riskScore);
  await logPolicyDecision(payload, decision);

  return {
    ok: true,
    configured: true,
    decision
  };
}

async function onPromptSubmitted(payload: PromptSubmittedRequest): Promise<void> {
  const runtimeState = getRuntimeState();
  if (!runtimeState.configured || !runtimeState.config) {
    return;
  }
  const protectedPayload = await applyCaptureMode(
    {
      prompt_text: payload.promptText,
      prompt_len: payload.promptText.length,
      user_justification: payload.justification
    },
    runtimeState.config.captureMode,
    ["prompt_text", "user_justification"]
  );
  const event = await buildEventEnvelope({
    config: runtimeState.config,
    eventType: "prompt_submitted",
    site: payload.site,
    url: payload.url,
    tabId: payload.tabId,
    userEmail: payload.userEmail,
    payload: protectedPayload
  });
  await enqueueEvent(event);
}

async function onResponseFinal(payload: ResponseFinalRequest): Promise<void> {
  const runtimeState = getRuntimeState();
  if (!runtimeState.configured || !runtimeState.config) {
    return;
  }
  const protectedPayload = await applyCaptureMode(
    {
      response_text: payload.responseText,
      response_len: payload.responseText.length,
      response_latency_ms: payload.latencyMs
    },
    runtimeState.config.captureMode,
    ["response_text"]
  );
  const event = await buildEventEnvelope({
    config: runtimeState.config,
    eventType: "response_final",
    site: payload.site,
    url: payload.url,
    tabId: payload.tabId,
    userEmail: payload.userEmail,
    payload: protectedPayload
  });
  await enqueueEvent(event);
}

async function onAdapterHealth(payload: AdapterHealthRequest): Promise<void> {
  const runtimeState = getRuntimeState();
  if (!runtimeState.configured || !runtimeState.config) {
    return;
  }
  const event = await buildEventEnvelope({
    config: runtimeState.config,
    eventType: "adapter_health",
    site: payload.site,
    url: payload.url,
    tabId: payload.tabId,
    payload: {
      status: payload.status,
      details: payload.details
    }
  });
  await enqueueEvent(event);
}

async function runPostConfigRefresh(): Promise<void> {
  await clearQueue();
  await resetEventChain();
  await refreshPolicyPack();
  await enforceBrowserSecurityAcrossTabs();
  await flushQueue();
}

async function bootstrap(): Promise<void> {
  await initConfigModule();
  await initPolicyCache();
  await refreshPolicyPack();
  initBrowserSecurityGuardrails();
  await enforceBrowserSecurityAcrossTabs();
  startUploader();
  chrome.alarms.create(POLICY_REFRESH_ALARM, { periodInMinutes: 5 });
  chrome.alarms.create(QUEUE_FLUSH_ALARM, { periodInMinutes: 1 });
}

chrome.runtime.onInstalled.addListener((details) => {
  void bootstrap();
  if (details.reason === "install" || details.reason === "update") {
    void refreshCaptureTabs();
  }
});

chrome.runtime.onStartup.addListener(() => {
  void bootstrap();
});

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === POLICY_REFRESH_ALARM) {
    void refreshRuntimeConfig()
      .then(() => refreshPolicyPack())
      .then(() => enforceBrowserSecurityAcrossTabs());
    return;
  }
  if (alarm.name === QUEUE_FLUSH_ALARM) {
    void flushQueue();
  }
});

chrome.runtime.onMessage.addListener((message: ContentToBackgroundMessage, _sender, sendResponse) => {
  void (async () => {
    try {
      if (message.type === "GET_CONFIG") {
        sendResponse({
          ok: true,
          config: sanitizedRuntimeState(getRuntimeState())
        });
        return;
      }
      if (message.type === "DISCONNECT_LOCAL_CONFIG") {
        const nextState = await clearLocalDevConfig();
        await clearQueue();
        await resetEventChain();
        await refreshPolicyPack();
        await enforceBrowserSecurityAcrossTabs();
        sendResponse({
          ok: true,
          config: sanitizedRuntimeState(nextState)
        });
        return;
      }
      if (message.type === "EVAL_PROMPT") {
        const result = await onEvalPrompt(message.payload);
        sendResponse({ ok: true, result });
        return;
      }
      if (message.type === "PROMPT_SUBMITTED") {
        await onPromptSubmitted(message.payload);
        sendResponse({ ok: true });
        return;
      }
      if (message.type === "RESPONSE_FINAL") {
        await onResponseFinal(message.payload);
        sendResponse({ ok: true });
        return;
      }
      if (message.type === "ADAPTER_HEALTH") {
        await onAdapterHealth(message.payload);
        sendResponse({ ok: true });
        return;
      }
      sendResponse({ ok: false, error: "Unknown message type." });
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : "Unexpected background error.";
      sendResponse({ ok: false, error: errorMessage });
    }
  })();
  return true;
});

chrome.runtime.onMessageExternal.addListener((rawMessage, sender, sendResponse) => {
  void (async () => {
    try {
      if (!isTrustedExternalSender(sender)) {
        sendResponse({ ok: false, error: "Untrusted sender." });
        return;
      }

      const message = rawMessage as ExternalConnectMessage;
      if (!message || typeof message !== "object" || typeof message.type !== "string") {
        sendResponse({ ok: false, error: "Invalid message payload." });
        return;
      }

      if (message.type === "UMAI_PING" || message.type === "DUVARAI_PING") {
        sendResponse({
          ok: true,
          state: sanitizedRuntimeState(getRuntimeState())
        });
        return;
      }

      if (message.type === "UMAI_CONNECT" || message.type === "DUVARAI_CONNECT") {
        const nextState = await setLocalDevConfig(message.payload ?? {});
        if (!nextState.configured) {
          sendResponse({
            ok: false,
            error: "Config validation failed.",
            issues: nextState.issues
          });
          return;
        }

        sendResponse({
          ok: true,
          state: sanitizedRuntimeState(nextState)
        });

        void runPostConfigRefresh().catch(() => {
          // Connect succeeds even if post-connect refresh tasks fail.
        });
        return;
      }

      if (message.type === "UMAI_DISCONNECT" || message.type === "DUVARAI_DISCONNECT") {
        const nextState = await clearLocalDevConfig();
        sendResponse({
          ok: true,
          state: sanitizedRuntimeState(nextState)
        });

        void (async () => {
          await clearQueue();
          await resetEventChain();
          await refreshPolicyPack();
          await enforceBrowserSecurityAcrossTabs();
        })().catch(() => {
          // Disconnect should remain successful even if cleanup tasks fail.
        });
        return;
      }

      sendResponse({ ok: false, error: "Unknown external message type." });
    } catch (error) {
      const errorMessage =
        error instanceof Error ? error.message : "Unexpected external message error.";
      sendResponse({ ok: false, error: errorMessage });
    }
  })();
  return true;
});

void bootstrap();
