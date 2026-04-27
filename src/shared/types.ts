export type SiteId = "chatgpt" | "gemini" | "claude";

export type EventType =
  | "prompt_attempted"
  | "policy_decision"
  | "prompt_submitted"
  | "response_final"
  | "adapter_health"
  | "shadow_ai_navigation";

export type CaptureMode = "metadata_only" | "full_content";

export type EvaluationMode = "local" | "server";

export type PolicyActionType = "allow" | "warn" | "block" | "redact" | "justify";

export interface BreakGlassConfig {
  enabled?: boolean;
  codeHash?: string;
}

export interface BrowserSecurityManagedConfig {
  enabled?: boolean;
  mode?: "audit" | "enforce";
  shadowAiDomains?: string[];
}

export interface BrowserSecurityConfig {
  enabled: boolean;
  mode: "audit" | "enforce";
  shadowAiDomains: string[];
}

export type FileInspectionIncompleteAction = "step_up" | "block" | "warn";

export interface FileInspectionManagedConfig {
  enabled?: boolean;
  maxFileBytes?: number;
  maxExtractedChars?: number;
  incompleteAction?: FileInspectionIncompleteAction;
  supportedTypes?: string[];
}

export interface FileInspectionConfig {
  enabled: boolean;
  maxFileBytes: number;
  maxExtractedChars: number;
  incompleteAction: FileInspectionIncompleteAction;
  supportedTypes: string[];
}

export interface ManagedConfig {
  tenantId?: string;
  environment?: "prod" | "stage";
  ingestBaseUrl?: string;
  eventsUrl?: string;
  policyUrl?: string;
  evaluateUrl?: string;
  evaluationMode?: EvaluationMode;
  controlCenterUrl?: string;
  userEmail?: string;
  userIdpSubject?: string;
  userDisplayName?: string;
  deviceToken?: string;
  deviceId?: string;
  bootstrapUrl?: string;
  bootstrapToken?: string;
  captureMode?: CaptureMode;
  retentionLocalDays?: number;
  debug?: boolean;
  allowedDomains?: string[];
  browserSecurity?: BrowserSecurityManagedConfig;
  fileInspection?: FileInspectionManagedConfig;
  breakGlass?: BreakGlassConfig;
}

export interface RuntimeConfig {
  tenantId: string;
  environment: "prod" | "stage";
  ingestBaseUrl: string;
  eventsUrl?: string;
  policyUrl: string;
  evaluateUrl?: string;
  evaluationMode: EvaluationMode;
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
  browserSecurity: BrowserSecurityConfig;
  fileInspection: FileInspectionConfig;
  breakGlass?: BreakGlassConfig;
}

export interface RuntimeState {
  configured: boolean;
  issues: string[];
  config?: RuntimeConfig;
}

export interface PolicyRuleAction {
  type: PolicyActionType;
  strategy?: "mask" | "token";
  min_chars?: number;
}

export interface PolicyRuleMatch {
  dlp_tags_any?: string[];
}

export interface PolicyRule {
  id: string;
  enabled: boolean;
  match: PolicyRuleMatch;
  action: PolicyRuleAction;
  message?: string;
}

export interface PolicyPack {
  version: string;
  default_action: PolicyActionType;
  rules: PolicyRule[];
}

export interface DlpFinding {
  type: string;
  start: number;
  end: number;
  confidence: number;
  sample?: string;
}

export interface DlpResult {
  tags: string[];
  findings: DlpFinding[];
  riskScore: number;
}

export interface RedactionSpan {
  start: number;
  end: number;
  kind: string;
}

export interface Decision {
  type: PolicyActionType;
  message?: string;
  rulesFired: string[];
  dlpTags: string[];
  redactions: RedactionSpan[];
  redactedText?: string;
  requireJustification: boolean;
  minJustificationChars?: number;
}

export interface ExtensionUser {
  user_email?: string;
  user_idp_subject?: string;
}

export interface ExtensionDevice {
  device_id: string;
}

export interface ExtensionApp {
  site: SiteId | "extension";
  url: string;
  tab_id?: number;
}

export interface ExtensionTimestamps {
  captured_at_ms: number;
}

export interface ExtensionChain {
  prev_event_hash: string | null;
  event_hash: string;
}

export interface BaseEvent {
  event_id: string;
  event_type: EventType;
  tenant_id: string;
  user: ExtensionUser;
  device: ExtensionDevice;
  app: ExtensionApp;
  timestamps: ExtensionTimestamps;
  chain: ExtensionChain;
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
  promptText: string;
  tabId?: number;
  userEmail?: string;
  attachments?: AttachmentManifest[];
}

export type AttachmentInspectionStatus =
  | "pending"
  | "extracted"
  | "server_required"
  | "too_large"
  | "unsupported"
  | "extraction_failed"
  | "truncated";

export interface AttachmentManifest {
  filename: string;
  mime: string;
  extension: string;
  size_bytes: number;
  sha256: string | null;
  inspection_status: AttachmentInspectionStatus;
  extracted_chars: number;
  truncated: boolean;
  extracted_text?: string;
  content_b64?: string;
  error?: string;
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
  promptText: string;
  justification?: string;
  tabId?: number;
  userEmail?: string;
}

export interface ResponseFinalRequest {
  site: SiteId;
  url: string;
  responseText: string;
  latencyMs?: number;
  tabId?: number;
  userEmail?: string;
}

export interface AdapterHealthRequest {
  site: SiteId;
  url: string;
  status: "ok" | "degraded" | "broken";
  details: string;
  tabId?: number;
}

export type ContentToBackgroundMessage =
  | { type: "GET_CONFIG" }
  | { type: "DISCONNECT_LOCAL_CONFIG" }
  | { type: "EVAL_PROMPT"; payload: EvalPromptRequest }
  | { type: "PROMPT_SUBMITTED"; payload: PromptSubmittedRequest }
  | { type: "RESPONSE_FINAL"; payload: ResponseFinalRequest }
  | { type: "ADAPTER_HEALTH"; payload: AdapterHealthRequest };

export type BackgroundToContentResponse =
  | {
      ok: true;
      result?: EvalPromptResponse;
      config?: RuntimeState;
      state?: RuntimeState;
    }
  | {
      ok: false;
      error: string;
      issues?: string[];
      config?: RuntimeState;
      state?: RuntimeState;
    };
