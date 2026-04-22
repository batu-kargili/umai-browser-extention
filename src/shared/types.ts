export type SiteId = "chatgpt" | "gemini" | "claude";

export type CaptureMode = "metadata_only" | "full_content";

export type DecisionType = "allow" | "warn" | "block" | "redact" | "justify";

export interface BreakGlassConfig {
  enabled?: boolean;
  codeHash?: string;
}

export interface ManagedConfig {
  tenantId?: string;
  environment?: "prod" | "stage";
  ingestBaseUrl?: string;
  policyUrl?: string;
  controlCenterUrl?: string;
  userEmail?: string;
  userIdpSubject?: string;
  userDisplayName?: string;
  deviceToken?: string;
  deviceId?: string;
  captureMode?: CaptureMode;
  retentionLocalDays?: number;
  debug?: boolean;
  allowedDomains?: string[];
  breakGlass?: BreakGlassConfig;
}

export interface RuntimeConfig {
  tenantId: string;
  environment: "prod" | "stage";
  ingestBaseUrl: string;
  policyUrl: string;
  controlCenterUrl: string;
  userEmail?: string;
  userIdpSubject?: string;
  userDisplayName?: string;
  deviceToken: string;
  deviceId: string;
  captureMode: CaptureMode;
  retentionLocalDays: number;
  debug: boolean;
  allowedDomains: string[];
  breakGlass?: BreakGlassConfig;
}

export interface RuntimeState {
  configured: boolean;
  issues: string[];
  config?: RuntimeConfig;
}

export interface DlpFinding {
  type: string;
  start: number;
  end: number;
  confidence: number;
  sample: string;
}

export interface DlpResult {
  tags: string[];
  findings: DlpFinding[];
  riskScore: number;
}

export interface PolicyMatchCondition {
  dlp_tags_any?: string[];
}

export interface PolicyAction {
  type: DecisionType;
  strategy?: "mask" | "token";
  min_chars?: number;
}

export interface PolicyRule {
  id: string;
  enabled: boolean;
  match: PolicyMatchCondition;
  action: PolicyAction;
  message?: string;
}

export interface PolicyPack {
  version: string;
  default_action: DecisionType;
  rules: PolicyRule[];
}

export interface Decision {
  type: DecisionType;
  message?: string;
  rulesFired: string[];
  dlpTags: string[];
  redactions: Array<{ start: number; end: number; kind: string }>;
  redactedText?: string;
  requireJustification: boolean;
  minJustificationChars?: number;
}

export interface AttachmentMeta {
  type?: string;
  name?: string;
  size?: number;
  mime?: string;
}

export type EventType =
  | "prompt_attempted"
  | "policy_decision"
  | "prompt_submitted"
  | "response_final"
  | "adapter_health"
  | "misconfigured";

export interface EventChain {
  prev_event_hash: string | null;
  event_hash: string;
}

export interface BaseEvent {
  event_id: string;
  event_type: EventType;
  tenant_id: string;
  user: {
    user_email?: string;
    user_idp_subject?: string;
  };
  device: {
    device_id: string;
    browser_profile_id?: string;
  };
  app: {
    site: SiteId | "extension";
    url: string;
    tab_id?: number;
  };
  timestamps: {
    captured_at_ms: number;
  };
  chain: EventChain;
  payload: Record<string, unknown>;
}

export interface QueueItem {
  createdAtMs: number;
  attemptCount: number;
  event: BaseEvent;
}

export interface EvalPromptRequest {
  site: SiteId;
  url: string;
  tabId?: number;
  promptText: string;
  userEmail?: string;
  attachments?: AttachmentMeta[];
}

export interface EvalPromptResponse {
  ok: boolean;
  configured: boolean;
  message?: string;
  decision: Decision;
}

export interface PromptSubmittedRequest {
  site: SiteId;
  url: string;
  tabId?: number;
  promptText: string;
  userEmail?: string;
  justification?: string;
}

export interface ResponseFinalRequest {
  site: SiteId;
  url: string;
  tabId?: number;
  responseText: string;
  userEmail?: string;
  latencyMs?: number;
}

export interface AdapterHealthRequest {
  site: SiteId;
  url: string;
  tabId?: number;
  status: "ok" | "degraded" | "broken";
  details?: string;
}

export type ContentToBackgroundMessage =
  | { type: "GET_CONFIG" }
  | { type: "DISCONNECT_LOCAL_CONFIG" }
  | { type: "EVAL_PROMPT"; payload: EvalPromptRequest }
  | { type: "PROMPT_SUBMITTED"; payload: PromptSubmittedRequest }
  | { type: "RESPONSE_FINAL"; payload: ResponseFinalRequest }
  | { type: "ADAPTER_HEALTH"; payload: AdapterHealthRequest };

export type BackgroundToContentResponse =
  | { ok: true; config: RuntimeState }
  | { ok: true; result: EvalPromptResponse }
  | { ok: true }
  | { ok: false; error: string };
