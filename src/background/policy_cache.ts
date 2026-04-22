import { getRuntimeState } from "./config";
import { getDefaultPolicyPack } from "../shared/policy_engine";
import type { PolicyPack } from "../shared/types";

const POLICY_CACHE_KEY = "umai_policy_cache_v1";
const POLICY_ETAG_KEY = "umai_policy_etag_v1";
const POLICY_FETCHED_AT_KEY = "umai_policy_fetched_at_ms_v1";

let policyPack: PolicyPack = getDefaultPolicyPack();

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

function isPolicyPack(value: unknown): value is PolicyPack {
  if (!value || typeof value !== "object") {
    return false;
  }
  const casted = value as PolicyPack;
  return (
    typeof casted.version === "string" &&
    typeof casted.default_action === "string" &&
    Array.isArray(casted.rules)
  );
}

export async function initPolicyCache(): Promise<void> {
  const cached = await storageLocalGet<PolicyPack>(POLICY_CACHE_KEY);
  if (cached && isPolicyPack(cached)) {
    policyPack = cached;
  }
}

export function getPolicyPack(): PolicyPack {
  return policyPack;
}

export async function refreshPolicyPack(): Promise<PolicyPack> {
  const runtimeState = getRuntimeState();
  if (!runtimeState.configured || !runtimeState.config) {
    return policyPack;
  }

  const policyUrl = runtimeState.config.policyUrl;
  const etag = await storageLocalGet<string>(POLICY_ETAG_KEY);
  const headers: Record<string, string> = {
    Authorization: `Bearer ${runtimeState.config.deviceToken}`,
    "X-Tenant-Id": runtimeState.config.tenantId
  };
  if (etag) {
    headers["If-None-Match"] = etag;
  }

  try {
    const response = await fetch(policyUrl, {
      method: "GET",
      headers
    });

    if (response.status === 304) {
      return policyPack;
    }

    if (!response.ok) {
      return policyPack;
    }

    const next = (await response.json()) as unknown;
    if (!isPolicyPack(next)) {
      return policyPack;
    }

    policyPack = next;

    await storageLocalSet({
      [POLICY_CACHE_KEY]: next,
      [POLICY_ETAG_KEY]: response.headers.get("ETag") ?? "",
      [POLICY_FETCHED_AT_KEY]: Date.now()
    });
  } catch (_error) {
    // Keep existing cached policy on network failures.
  }

  return policyPack;
}
