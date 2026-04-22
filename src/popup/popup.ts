import type { RuntimeState } from "../shared/types";

const DEFAULT_CONTROL_CENTER_URL = "https://duvarai-controlcenter-442107147924.europe-west3.run.app";
const CONTROL_CENTER_CONNECT_PATH = "/extension/connect";

interface InternalMessageResponse {
  ok: boolean;
  config?: RuntimeState;
  error?: string;
}

function byId(id: string): HTMLElement {
  const element = document.getElementById(id);
  if (!element) {
    throw new Error(`Missing popup element: ${id}`);
  }
  return element;
}

function setStatus(text: string, tone: "ok" | "warn" | "error"): void {
  const element = byId("statusText");
  element.textContent = text;
  element.className = `status ${tone}`;
}

function safeControlCenterUrl(state?: RuntimeState): string {
  if (!state?.configured || !state.config?.controlCenterUrl) {
    return DEFAULT_CONTROL_CENTER_URL;
  }
  try {
    return new URL(state.config.controlCenterUrl).origin;
  } catch (_error) {
    return DEFAULT_CONTROL_CENTER_URL;
  }
}

function sendInternalMessage(message: object): Promise<InternalMessageResponse> {
  return new Promise((resolve, reject) => {
    chrome.runtime.sendMessage(message, (response: InternalMessageResponse) => {
      const runtimeError = chrome.runtime.lastError;
      if (runtimeError) {
        reject(new Error(runtimeError.message));
        return;
      }
      resolve(response);
    });
  });
}

async function loadRuntimeState(): Promise<RuntimeState | null> {
  const response = await sendInternalMessage({ type: "GET_CONFIG" });
  if (!response.ok || !response.config) {
    return null;
  }
  return response.config;
}

function renderState(state: RuntimeState | null): void {
  const tenantValue = byId("tenantValue");
  const endpointValue = byId("endpointValue");

  if (!state || !state.configured || !state.config) {
    tenantValue.textContent = "-";
    endpointValue.textContent = "-";
    setStatus("Not connected. Use Connect organization.", "warn");
    return;
  }

  tenantValue.textContent = state.config.tenantId;
  endpointValue.textContent = state.config.ingestBaseUrl;
  setStatus("Connected to organization.", "ok");
}

async function refresh(): Promise<RuntimeState | null> {
  try {
    const state = await loadRuntimeState();
    renderState(state);
    return state;
  } catch (error) {
    const text = error instanceof Error ? error.message : "Failed to read extension state.";
    setStatus(text, "error");
    return null;
  }
}

async function openControlCenterConnect(): Promise<void> {
  const state = await refresh();
  const controlCenterUrl = safeControlCenterUrl(state ?? undefined);
  const next = new URL(CONTROL_CENTER_CONNECT_PATH, controlCenterUrl);
  next.searchParams.set("extId", chrome.runtime.id);
  chrome.tabs.create({ url: next.toString() });
  window.close();
}

async function disconnect(): Promise<void> {
  try {
    const response = await sendInternalMessage({ type: "DISCONNECT_LOCAL_CONFIG" });
    if (!response.ok) {
      setStatus(response.error ?? "Failed to disconnect local connection.", "error");
      return;
    }
    renderState(response.config ?? null);
  } catch (error) {
    const text = error instanceof Error ? error.message : "Disconnect failed.";
    setStatus(text, "error");
  }
}

function init(): void {
  byId("connectButton").addEventListener("click", () => {
    void openControlCenterConnect();
  });
  byId("disconnectButton").addEventListener("click", () => {
    void disconnect();
  });
  byId("refreshButton").addEventListener("click", () => {
    void refresh();
  });
  void refresh();
}

document.addEventListener("DOMContentLoaded", init);
