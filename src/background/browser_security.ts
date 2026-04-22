import { getBrowserSecurityConfig, getRuntimeState } from "./config";
import { buildEventEnvelope } from "./events";
import { enqueueEvent } from "./queue";

const BLOCKED_PAGE_PATH = "blocked.html";
const handledNavigationByTab = new Map<number, string>();
let initialized = false;

interface BrowserSecurityDecision {
  action: "audit" | "block";
  allowedDomains: string[];
  blockedUrl: string;
  configured: boolean;
  hostname: string;
  matchedDomain: string;
  message: string;
  mode: "audit" | "enforce";
}

function safeParseUrl(url: string): URL | null {
  try {
    return new URL(url);
  } catch (_error) {
    return null;
  }
}

function matchesDomain(hostname: string, domain: string): boolean {
  return hostname === domain || hostname.endsWith(`.${domain}`);
}

function isBlockedPageUrl(url: string): boolean {
  return url.startsWith(chrome.runtime.getURL(BLOCKED_PAGE_PATH));
}

function evaluateBrowserSecurity(url: string): BrowserSecurityDecision | null {
  if (isBlockedPageUrl(url)) {
    return null;
  }

  const parsedUrl = safeParseUrl(url);
  if (!parsedUrl || (parsedUrl.protocol !== "http:" && parsedUrl.protocol !== "https:")) {
    return null;
  }

  const runtimeState = getRuntimeState();
  const allowedDomains = runtimeState.configured && runtimeState.config ? runtimeState.config.allowedDomains : [];
  const hostname = parsedUrl.hostname.toLowerCase();
  if (allowedDomains.some((domain) => matchesDomain(hostname, domain))) {
    return null;
  }

  const browserSecurity = getBrowserSecurityConfig();
  if (!browserSecurity.enabled) {
    return null;
  }

  const matchedDomain = browserSecurity.shadowAiDomains.find((domain) => matchesDomain(hostname, domain));
  if (!matchedDomain) {
    return null;
  }

  if (!runtimeState.configured || !runtimeState.config) {
    return {
      action: "block",
      allowedDomains: [],
      blockedUrl: url,
      configured: false,
      hostname,
      matchedDomain,
      message: "UMAI browser guardrails are not connected. Known AI sites stay blocked until the organization is connected.",
      mode: "enforce"
    };
  }

  if (browserSecurity.mode === "audit") {
    return {
      action: "audit",
      allowedDomains,
      blockedUrl: url,
      configured: true,
      hostname,
      matchedDomain,
      message: "Known AI site detected outside the approved UMAI allowlist.",
      mode: "audit"
    };
  }

  return {
    action: "block",
    allowedDomains,
    blockedUrl: url,
    configured: true,
    hostname,
    matchedDomain,
    message: "This AI site is not approved by your organization. Use an approved assistant instead.",
    mode: "enforce"
  };
}

function buildBlockedPageUrl(decision: BrowserSecurityDecision): string {
  const next = new URL(chrome.runtime.getURL(BLOCKED_PAGE_PATH));
  next.searchParams.set("blocked", decision.blockedUrl);
  next.searchParams.set("host", decision.hostname);
  next.searchParams.set("mode", decision.configured ? decision.mode : "fail-closed");
  next.searchParams.set("reason", decision.message);
  if (decision.allowedDomains.length > 0) {
    next.searchParams.set("approved", decision.allowedDomains.join(","));
  }
  return next.toString();
}

function queryTabs(): Promise<chrome.tabs.Tab[]> {
  return new Promise((resolve) => {
    chrome.tabs.query({}, (tabs) => {
      resolve(Array.isArray(tabs) ? tabs : []);
    });
  });
}

function updateTab(tabId: number, url: string): Promise<boolean> {
  return new Promise((resolve) => {
    chrome.tabs.update(tabId, { url }, () => {
      resolve(!chrome.runtime.lastError);
    });
  });
}

async function logBrowserSecurityDecision(tabId: number, decision: BrowserSecurityDecision): Promise<void> {
  const runtimeState = getRuntimeState();
  if (!runtimeState.configured || !runtimeState.config) {
    return;
  }

  const event = await buildEventEnvelope({
    config: runtimeState.config,
    eventType: "shadow_ai_navigation",
    site: "extension",
    url: decision.blockedUrl,
    tabId,
    payload: {
      action: decision.action,
      allowed_domains: decision.allowedDomains,
      blocked_host: decision.hostname,
      blocked_url: decision.blockedUrl,
      configured: decision.configured,
      guard_mode: decision.mode,
      matched_domain: decision.matchedDomain,
      reason: decision.message
    }
  });
  await enqueueEvent(event);
}

export async function handleBrowserSecurityForTab(tabId: number, url: string): Promise<void> {
  if (isBlockedPageUrl(url)) {
    handledNavigationByTab.delete(tabId);
    return;
  }

  const decision = evaluateBrowserSecurity(url);
  if (!decision) {
    handledNavigationByTab.delete(tabId);
    return;
  }

  if (handledNavigationByTab.get(tabId) === url) {
    return;
  }
  handledNavigationByTab.set(tabId, url);

  await logBrowserSecurityDecision(tabId, decision);
  if (decision.action !== "block") {
    return;
  }

  const redirected = await updateTab(tabId, buildBlockedPageUrl(decision));
  if (!redirected) {
    handledNavigationByTab.delete(tabId);
  }
}

export function initBrowserSecurityGuardrails(): void {
  if (initialized) {
    return;
  }
  initialized = true;

  chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
    const nextUrl =
      typeof changeInfo.url === "string" ? changeInfo.url : tab.pendingUrl ?? tab.url;
    if (!nextUrl) {
      return;
    }
    void handleBrowserSecurityForTab(tabId, nextUrl);
  });

  chrome.tabs.onRemoved.addListener((tabId) => {
    handledNavigationByTab.delete(tabId);
  });
}

export async function enforceBrowserSecurityAcrossTabs(): Promise<void> {
  const tabs = await queryTabs();
  await Promise.all(
    tabs.map((tab) => {
      if (typeof tab.id !== "number") {
        return Promise.resolve();
      }
      const url = tab.pendingUrl ?? tab.url;
      if (!url) {
        return Promise.resolve();
      }
      return handleBrowserSecurityForTab(tab.id, url);
    })
  );
}
