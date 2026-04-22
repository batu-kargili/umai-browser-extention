import {
  initConfigModule,
  getRuntimeState,
  isUrlAllowed,
  refreshRuntimeConfig,
  setLocalDevConfig,
  clearLocalDevConfig
} from "./config";
import { initPolicyCache, refreshPolicyPack, getPolicyPack } from "./policy_cache";
import { startUploader, flushQueue } from "./uploader";
import { clearQueue, enqueueEvent } from "./queue";
import { applyCaptureMode, buildEventEnvelope, resetEventChain } from "./events";
import { scanTextForDlp } from "../shared/dlp";
import { evaluatePromptPolicy } from "../shared/policy_engine";
import type {
  AdapterHealthRequest,
  ContentToBackgroundMessage,
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
  | { type: "DUVARAI_PING" }
  | { type: "DUVARAI_CONNECT"; payload: ManagedConfig }
  | { type: "DUVARAI_DISCONNECT" };

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

function sanitizedRuntimeState(state: RuntimeState): RuntimeState {
  if (!state.configured || !state.config) {
    return state;
  }
  return {
    configured: true,
    issues: [],
    config: {
      ...state.config,
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
      attachments: payload.attachments ?? [],
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

async function logPolicyDecision(payload: EvalPromptRequest, decision: EvalPromptResponse["decision"]): Promise<void> {
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
      runtimeState.issues.length > 0 ? runtimeState.issues.join(" ") : "Managed policy or local org connection not available.";
    return {
      ok: false,
      configured: false,
      message: "Extension is not configured. Connect organization from DuvarAI Control Center.",
      decision: {
        type: "block",
        message: `DuvarAI extension is not configured. ${missingDetails}`,
        rulesFired: ["managed_config_missing"],
        dlpTags: [],
        redactions: [],
        requireJustification: false
      }
    };
  }

  const dlp = scanTextForDlp(payload.promptText);
  const decision = evaluatePromptPolicy(payload.promptText, dlp, getPolicyPack());

  await logPromptAttempted(payload, dlp.tags, dlp.riskScore);
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

async function bootstrap(): Promise<void> {
  await initConfigModule();
  await initPolicyCache();
  await refreshPolicyPack();
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
    void refreshRuntimeConfig().then(() => refreshPolicyPack());
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
        const state = await clearLocalDevConfig();
        await clearQueue();
        await resetEventChain();
        await refreshPolicyPack();
        sendResponse({
          ok: true,
          config: sanitizedRuntimeState(state)
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

      if (message.type === "DUVARAI_PING") {
        sendResponse({
          ok: true,
          state: sanitizedRuntimeState(getRuntimeState())
        });
        return;
      }

      if (message.type === "DUVARAI_CONNECT") {
        const next = await setLocalDevConfig(message.payload ?? {});
        if (!next.configured) {
          sendResponse({
            ok: false,
            error: "Config validation failed.",
            issues: next.issues
          });
          return;
        }

        // Acknowledge connect immediately to avoid Control Center timeout on slow network tasks.
        sendResponse({
          ok: true,
          state: sanitizedRuntimeState(next)
        });

        void (async () => {
          await clearQueue();
          await resetEventChain();
          await refreshPolicyPack();
          await flushQueue();
        })().catch(() => {
          // Connect succeeds even if post-connect refresh/upload tasks fail.
        });
        return;
      }

      if (message.type === "DUVARAI_DISCONNECT") {
        const next = await clearLocalDevConfig();
        sendResponse({
          ok: true,
          state: sanitizedRuntimeState(next)
        });

        void (async () => {
          await clearQueue();
          await resetEventChain();
          await refreshPolicyPack();
        })().catch(() => {
          // Disconnect should remain successful even if cleanup tasks fail.
        });
        return;
      }

      sendResponse({ ok: false, error: "Unknown external message type." });
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : "Unexpected external message error.";
      sendResponse({ ok: false, error: errorMessage });
    }
  })();
  return true;
});

void bootstrap();
