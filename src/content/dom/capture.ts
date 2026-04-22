import { createSiteAdapter } from "../adapter_base";
import { observeStableAssistantText } from "./observer";
import type { SiteSelectors } from "./selectors";
import type {
  BackgroundToContentResponse,
  ContentToBackgroundMessage,
  Decision,
  EvalPromptResponse,
  SiteId
} from "../../shared/types";
import { showToast } from "../ui/overlay";
import {
  showBlockedModal,
  showJustificationModal,
  showRedactModal,
  showWarnModal
} from "../ui/modal";

interface CaptureOptions {
  siteId: SiteId;
  selectors: SiteSelectors;
}

const EXTENSION_RELOAD_MESSAGE = "DuvarAI extension updated. Reload this tab to resume monitoring.";

function sendMessage<T>(message: ContentToBackgroundMessage): Promise<T> {
  return new Promise((resolve, reject) => {
    try {
      if (!chrome?.runtime?.id) {
        reject(new Error("Extension context invalidated."));
        return;
      }
      chrome.runtime.sendMessage(message, (response: T) => {
        const runtimeError = chrome.runtime.lastError;
        if (runtimeError) {
          reject(new Error(runtimeError.message));
          return;
        }
        resolve(response);
      });
    } catch (error) {
      reject(error instanceof Error ? error : new Error("Extension messaging failed."));
    }
  });
}

function collectDecisionDetails(decision: Decision): string[] {
  const details: string[] = [];
  if (decision.rulesFired.length > 0) {
    details.push(`Rules: ${decision.rulesFired.join(", ")}`);
  }
  if (decision.dlpTags.length > 0) {
    details.push(`DLP tags: ${decision.dlpTags.join(", ")}`);
  }
  return details;
}

function isExtensionRuntimeUnavailable(error: unknown): boolean {
  if (!(error instanceof Error)) {
    return false;
  }
  return (
    error.message.includes("Extension context invalidated") ||
    error.message.includes("Receiving end does not exist") ||
    error.message.includes("message port closed")
  );
}

export function startCapture(options: CaptureOptions): void {
  const adapter = createSiteAdapter(options.siteId, options.selectors);

  let programmaticSend = false;
  let submitInFlight = false;
  let lastSubmittedAt = 0;
  let lastSubmittedResponse = "";
  let healthSignature = "";
  let observerDisconnect: (() => void) | null = null;
  let healthIntervalId: number | null = null;
  let captureDisabled = false;
  let reloadToastShown = false;

  const disableCapture = (): void => {
    if (captureDisabled) {
      return;
    }
    captureDisabled = true;
    if (observerDisconnect) {
      observerDisconnect();
      observerDisconnect = null;
    }
    if (healthIntervalId !== null) {
      window.clearInterval(healthIntervalId);
      healthIntervalId = null;
    }
    document.removeEventListener("keydown", onKeyDown, true);
    document.removeEventListener("click", onClick, true);
    if (!reloadToastShown) {
      reloadToastShown = true;
      showToast(EXTENSION_RELOAD_MESSAGE, "warn");
    }
  };

  const evaluateHealth = async (): Promise<void> => {
    if (captureDisabled) {
      return;
    }
    const input = adapter.locateInput();
    const root = adapter.locateConversationRoot();
    let status: "ok" | "degraded" | "broken" = "ok";
    let details = "selectors healthy";
    if (!input && !root) {
      status = "broken";
      details = "input and conversation root not found";
    } else if (!input || !root) {
      status = "degraded";
      details = !input ? "input selector missing" : "conversation root selector missing";
    }
    const signature = `${status}:${details}`;
    if (signature === healthSignature) {
      return;
    }
    healthSignature = signature;
    await sendMessage<BackgroundToContentResponse>({
      type: "ADAPTER_HEALTH",
      payload: {
        site: options.siteId,
        url: window.location.href,
        status,
        details
      }
    }).catch(() => undefined);
  };

  const startResponseObserver = (): void => {
    if (captureDisabled || observerDisconnect) {
      return;
    }
    const root = adapter.locateConversationRoot();
    if (!root) {
      return;
    }
    observerDisconnect = observeStableAssistantText({
      root,
      stabilityMs: 1400,
      getLatestText: () => {
        const messages = adapter.locateAssistantMessages();
        if (messages.length === 0) {
          return "";
        }
        return messages[messages.length - 1]?.innerText?.trim() ?? "";
      },
      onStable: (text) => {
        if (captureDisabled || !text || text === lastSubmittedResponse) {
          return;
        }
        lastSubmittedResponse = text;
        const latencyMs = lastSubmittedAt > 0 ? Date.now() - lastSubmittedAt : undefined;
        void sendMessage<BackgroundToContentResponse>({
          type: "RESPONSE_FINAL",
          payload: {
            site: options.siteId,
            url: window.location.href,
            responseText: text,
            latencyMs
          }
        }).catch(() => undefined);
      }
    });
  };

  const decideAndMaybeSubmit = async (originalPrompt: string): Promise<void> => {
    if (captureDisabled) {
      return;
    }
    const evalResponse = await sendMessage<BackgroundToContentResponse>({
      type: "EVAL_PROMPT",
      payload: {
        site: options.siteId,
        url: window.location.href,
        promptText: originalPrompt
      }
    });

    if (!("result" in evalResponse) || !evalResponse.result) {
      showToast("Failed to evaluate policy decision.", "block");
      return;
    }

    const result = evalResponse.result as EvalPromptResponse;
    const decision = result.decision;
    const details = collectDecisionDetails(decision);
    const decisionMessage = decision.message ?? "Policy decision returned by DuvarAI.";

    let proceed = false;
    let finalPrompt = originalPrompt;
    let justification: string | undefined;

    if (decision.type === "allow") {
      proceed = true;
    } else if (decision.type === "warn") {
      proceed = await showWarnModal(decisionMessage, details);
    } else if (decision.type === "justify") {
      const minChars = decision.minJustificationChars ?? 10;
      const resultJustify = await showJustificationModal(decisionMessage, minChars, details);
      proceed = resultJustify.proceed;
      justification = resultJustify.justification;
    } else if (decision.type === "redact") {
      const redacted = decision.redactedText ?? originalPrompt;
      proceed = await showRedactModal(decisionMessage, originalPrompt, redacted, details);
      if (proceed) {
        finalPrompt = redacted;
      }
    } else {
      await showBlockedModal(decisionMessage, details);
      showToast("Prompt blocked by policy.", "block");
      proceed = false;
    }

    if (!proceed) {
      return;
    }

    if (finalPrompt !== originalPrompt) {
      adapter.setPromptText(finalPrompt);
      showToast("Sensitive text redacted before submit.", "warn");
    }

    await sendMessage<BackgroundToContentResponse>({
      type: "PROMPT_SUBMITTED",
      payload: {
        site: options.siteId,
        url: window.location.href,
        promptText: finalPrompt,
        justification
      }
    }).catch(() => undefined);

    programmaticSend = true;
    try {
      adapter.submitPrompt();
      lastSubmittedAt = Date.now();
      if (decision.type === "warn" || decision.type === "justify") {
        showToast("Prompt submitted with policy acknowledgment.", "warn");
      }
    } finally {
      setTimeout(() => {
        programmaticSend = false;
      }, 0);
    }
  };

  const handleSubmitInterception = async (event: Event): Promise<void> => {
    if (captureDisabled || programmaticSend || submitInFlight) {
      return;
    }
    const prompt = adapter.getPromptText();
    if (!prompt) {
      return;
    }
    submitInFlight = true;
    event.preventDefault();
    event.stopPropagation();
    if ("stopImmediatePropagation" in event && typeof event.stopImmediatePropagation === "function") {
      event.stopImmediatePropagation();
    }
    try {
      await decideAndMaybeSubmit(prompt);
    } catch (error) {
      if (isExtensionRuntimeUnavailable(error)) {
        disableCapture();
        return;
      }
      showToast("Failed to evaluate policy decision.", "block");
    } finally {
      submitInFlight = false;
    }
  };

  const onKeyDown = (event: Event): void => {
    if (!(event instanceof KeyboardEvent)) {
      return;
    }
    if (event.key !== "Enter" || event.shiftKey || event.ctrlKey || event.metaKey || event.altKey) {
      return;
    }
    const input = adapter.locateInput();
    if (!input) {
      return;
    }
    const target = event.target;
    if (!(target instanceof Node) || (!input.contains(target) && target !== input)) {
      return;
    }
    void handleSubmitInterception(event);
  };

  const onClick = (event: Event): void => {
    const sendButton = adapter.locateSendButton();
    if (!sendButton) {
      return;
    }
    const target = event.target;
    if (!(target instanceof Node) || (!sendButton.contains(target) && target !== sendButton)) {
      return;
    }
    void handleSubmitInterception(event);
  };

  document.addEventListener("keydown", onKeyDown, true);
  document.addEventListener("click", onClick, true);

  startResponseObserver();
  void evaluateHealth();

  healthIntervalId = window.setInterval(() => {
    startResponseObserver();
    void evaluateHealth();
  }, 15000);

  showToast("DuvarAI browser governance active.", "ok");
}
