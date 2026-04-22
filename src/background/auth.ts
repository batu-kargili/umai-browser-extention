import type { RuntimeConfig } from "../shared/types";

export function buildAuthHeaders(config: RuntimeConfig): Record<string, string> {
  return {
    Authorization: `Bearer ${config.deviceToken}`,
    "X-Tenant-Id": config.tenantId,
    "X-Device-Id": config.deviceId
  };
}

