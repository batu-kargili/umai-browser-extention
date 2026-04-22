# Browser LLM Governance Extension — MVP Development Plan (Codex-Ready)

> **Goal:** Build a **Chrome Extension (Manifest V3)** that **logs and governs** browser-only usage of **ChatGPT / Gemini / Claude** (prompts, attachment metadata, and received answers) and streams events into **UMAI Ledger**.
>
> **MVP approach:** **UI-layer capture + policy enforcement at submit time** (content scripts + DOM observation).  
> **Do not depend** on network interception for prompt/answer bodies in MV3.

---

## 0) MVP Goals & Non‑Goals

### Goals (MVP)
- Capture **prompt text** and **final assistant answer** on:
  - ChatGPT web
  - Gemini web
  - Claude web
- Govern at prompt submit:
  - **allow / warn / block / redact / justify**
- Log to UMAI:
  - append-only events + **tamper-evident hash chain**
  - encryption-in-transit + **optional payload encryption**
- Enterprise deployment:
  - **force-install** via policy
  - read-only managed configuration via **`chrome.storage.managed`**

### Non‑Goals (MVP)
- Perfect fidelity of underlying API payloads (tool calls, internal streaming frames)
- Full network MITM interception
- Cross-browser support (Edge/Firefox later)

---

## 1) System Architecture

### Extension Components
- **MV3 Service Worker (background)**  
  Config load, auth, policy cache, event queue, uploader, crypto helpers.
- **Content Scripts** (domain-specific adapters)  
  DOM capture, submit interception, response capture.
- **In-page Overlay UI**  
  warn/block/redact/justify UX (modal/toast).
- **Shared libs**  
  Policy engine, DLP scanning, redaction, hashing, types.

### Backend Components (UMAI MVP)
- `/v1/ext/bootstrap` — tenant config + policy metadata + keys
- `/v1/ext/policy` — policy pack (ETag)
- `/v1/ext/events` — batch ingest
- `/v1/ext/heartbeat` — device status (optional)

---

## 2) Repo Layout (Recommended)

```
/src
  /background
    service_worker.ts
    config.ts
    auth.ts
    policy_cache.ts
    uploader.ts
    crypto.ts
    queue.ts
  /content
    adapter_base.ts
    sites/
      chatgpt.ts
      gemini.ts
      claude.ts
    dom/
      selectors.ts
      observer.ts
      capture.ts
    ui/
      overlay.ts
      modal.ts
  /shared
    types.ts
    policy_engine.ts
    dlp.ts
    redact.ts
    hash.ts
/manifest.json
/schema.json
```

Build output: `/dist` (MV3 packed extension)

---

## 3) Configuration & Enterprise Deployment

### 3.1 Force-install (Enterprise)
- Expect enterprise admins to force-install via:
  - Google Admin Console (ChromeOS / managed Chrome)
  - Windows GPO / Intune / Edge policies (later)
- MVP must be robust when users **cannot disable/uninstall**.

### 3.2 Managed Configuration (`chrome.storage.managed`)
Use **managed storage** so admins can set config without user changes.

**Managed config fields (schema.json)**
- `tenantId` (string, required)
- `environment` (`prod` | `stage`, required)
- `ingestBaseUrl` (string, required)
- `policyUrl` (string, required)
- `deviceToken` (string, required for MVP auth)
- `deviceId` (string, optional; generate if absent)
- `captureMode` (`metadata_only` | `full_content`, default: `metadata_only`)
- `retentionLocalDays` (int, default: 7)
- `debug` (bool, default: false)
- `allowedDomains` (array, default: official LLM domains)
- `breakGlass` (object, optional)
  - `enabled` (bool)
  - `codeHash` (string, e.g., bcrypt hash)

**Fail-closed:** If required config missing → extension blocks capture/governance and emits a `misconfigured` event (metadata only) when possible.

---

## 4) Domains & Permissions (MVP)

### Target domains (MVP)
- ChatGPT: `https://chatgpt.com/*` (and/or `https://chat.openai.com/*` if needed)
- Gemini: `https://gemini.google.com/*`
- Claude: `https://claude.ai/*`

### Permissions (minimum viable)
- `"storage"` (managed + local)
- `"tabs"` (tab metadata only)
- `"host_permissions"` limited to above domains
- `"scripting"` only if you plan dynamic injection (optional; prefer static content_scripts in MVP)

---

## 5) Data Model — UMAI Ledger Friendly

### 5.1 Event Envelope
All events share:
- `event_id` (uuid)
- `tenant_id`
- `user`:
  - `user_email` (best-effort)
  - `user_idp_subject` (optional)
- `device`:
  - `device_id`
  - `browser_profile_id` (optional)
- `app`:
  - `site` (`chatgpt` | `gemini` | `claude`)
  - `url`
  - `tab_id`
- `timestamps`:
  - `captured_at_ms`
- `chain` (tamper-evident):
  - `prev_event_hash`
  - `event_hash`  *(hash of canonicalized event content)*
- `payload`:
  - if `captureMode=full_content`: send encrypted content
  - if `metadata_only`: send only hashes, tags, decisions, lengths

### 5.2 Event Types (MVP)
1) `prompt_attempted`
   - `prompt_text` OR `prompt_hash`
   - `attachments`: [{ `type`, `name`, `size`, `mime` }] (no bytes)
   - `ui_model_hint` (optional)
2) `policy_decision`
   - `decision`: `allow|warn|block|redact|justify`
   - `rules_fired`: [rule_id...]
   - `dlp_tags`: [...]
   - `redactions`: [{start,end,type}] (if applied)
   - `user_justification` (if required and provided)
3) `prompt_submitted`
   - `prompt_text` OR `prompt_hash`
4) `response_final`
   - `response_text` OR `response_hash`
   - `response_len`
   - `response_latency_ms` (best-effort)
5) `adapter_health`
   - `status`: `ok|degraded|broken`
   - `details`: selector failures, unknown DOM state

---

## 6) Policy Model (MVP)

### 6.1 Policy Pack JSON (example)
```json
{
  "version": "2026-02-24.1",
  "default_action": "allow",
  "rules": [
    {
      "id": "block_secrets",
      "enabled": true,
      "match": { "dlp_tags_any": ["SECRET_TOKEN", "PRIVATE_KEY"] },
      "action": { "type": "block" },
      "message": "Sensitive secret detected. Remove credentials before sending."
    },
    {
      "id": "warn_pii",
      "enabled": true,
      "match": { "dlp_tags_any": ["PII_EMAIL", "PII_PHONE"] },
      "action": { "type": "justify", "min_chars": 10 },
      "message": "Possible PII detected. Provide justification to proceed."
    },
    {
      "id": "redact_iban_cc",
      "enabled": true,
      "match": { "dlp_tags_any": ["PII_IBAN", "PII_CREDITCARD"] },
      "action": { "type": "redact", "strategy": "mask" },
      "message": "Financial identifier detected. It will be redacted."
    }
  ]
}
```

### 6.2 Policy Evaluation Rules
- Evaluate in order; **first match wins** (documented).
- Always return an explanation object:
  - decision + rules_fired + user_message + redactions + dlp_tags.

---

## 7) DLP Scanning & Redaction (On-device)

### 7.1 Detectors (MVP)
- **Secrets**
  - common API key formats
  - `Bearer ...` tokens
  - PEM private key blocks
- **PII**
  - email
  - phone
  - credit card + **Luhn**
  - IBAN (TR + generic)

### 7.2 DLP Output
- `tags`: list
- `findings`: [{type, start, end, confidence}]
- `risk_score`: simple weighted sum

### 7.3 Redaction Output
- Replace sensitive spans with `[REDACTED:<TYPE>]` or masked values.
- When policy forbids, **do not retain original** prompt/answer in local storage beyond immediate decision flow.

---

## 8) Work Packages (Implementation Steps)

### WP1 — Project Scaffold (TS + bundler)
**Tasks**
- [ ] Create TS project
- [ ] MV3 build pipeline to `/dist`
- [ ] Lint + unit test setup
- [ ] Local dev docs (load unpacked extension)

**Outputs**
- dist/service_worker.js
- dist/content scripts bundle(s)

---

### WP2 — MV3 Manifest + Managed Schema
**Tasks**
- [ ] `manifest.json` with MV3 background service worker
- [ ] `content_scripts` for domains with `matches`
- [ ] `storage.managed_schema` referencing `schema.json`
- [ ] restrict `host_permissions` to only LLM domains
- [ ] add `web_accessible_resources` if overlay assets needed

**Acceptance**
- [ ] Extension loads without warnings
- [ ] Managed storage is readable and validated

---

### WP3 — Background: Config Loader + Policy Cache
**Tasks**
- [ ] Read `chrome.storage.managed` at startup and on change
- [ ] Validate config; derive `device_id` if missing
- [ ] Fetch policy JSON from `policyUrl`
- [ ] Support ETag caching (If-None-Match)
- [ ] Store `policy_version` locally

**Acceptance**
- [ ] Policy updates apply without reinstall
- [ ] Fail-closed on missing config (emit `misconfigured`)

---

### WP4 — Background: Event Queue + Uploader
**Tasks**
- [ ] Implement durable queue in `chrome.storage.local`
- [ ] Batch upload to `/v1/ext/events`
- [ ] Retry with exponential backoff + jitter
- [ ] Queue compaction and TTL based on `retentionLocalDays`
- [ ] Offline mode support

**Acceptance**
- [ ] Events survive browser restart
- [ ] No unbounded growth

---

### WP5 — Background: Crypto + Hash Chain
**Tasks**
- [ ] Canonicalize event payload (stable JSON)
- [ ] Compute `event_hash` (SHA-256)
- [ ] Chain with `prev_event_hash` per device/session
- [ ] Optional envelope encryption for full_content:
  - AES-GCM per event
  - wrap AES key with tenant RSA public key
- [ ] Include `key_id` + `alg` in envelope

**Acceptance**
- [ ] Server can verify integrity chain
- [ ] Encryption toggled by captureMode

---

### WP6 — Content: Adapter Framework
**Tasks**
- [ ] `adapter_base.ts` defines interface
- [ ] Each site adapter implements:
  - locate input editor (textarea/contenteditable)
  - locate send action
  - locate conversation root
  - parse last assistant message reliably
- [ ] Health checks and fallback selectors
- [ ] Emit `adapter_health` when broken

**Acceptance**
- [ ] Captures prompt + answer in typical flows on all 3 sites

---

### WP7 — Content: Submit Interception + Governance Flow
**Tasks**
- [ ] Intercept send click/Enter
- [ ] Read prompt text
- [ ] Run local DLP scan
- [ ] Request policy evaluation from background
- [ ] Apply decision:
  - allow → re-trigger send
  - warn → modal; proceed/edit
  - justify → modal; require justification
  - redact → show diff preview; replace prompt; send
  - block → show reason; do not send
- [ ] Emit events: prompt_attempted → policy_decision → (prompt_submitted if allowed)

**Acceptance**
- [ ] No double-send bugs
- [ ] User UX is clear and keyboard-accessible

---

### WP8 — Content: Response Capture (Final Answer)
**Tasks**
- [ ] MutationObserver on conversation root
- [ ] Detect assistant message nodes
- [ ] Determine “final” message (stability window, e.g., no changes for N ms)
- [ ] Extract text (sanitize and normalize whitespace)
- [ ] Send `response_final` event to background

**Acceptance**
- [ ] Captures final answer text in most sessions
- [ ] Emits degraded status if cannot confidently parse

---

### WP9 — In-page Overlay UI (Warn/Block/Redact/Justify)
**Tasks**
- [ ] Minimal overlay: toast + modal
- [ ] Modal supports:
  - reason text
  - list of rule IDs
  - proceed/edit buttons
  - justification input when required
  - redact diff preview (before/after)
- [ ] Debug panel only when managed `debug=true`

**Acceptance**
- [ ] Minimal friction when allowed
- [ ] No layout breaking on target websites

---

## 9) Messaging Protocol (Content ↔ Background)

### Messages (Content → Background)
- `EVAL_PROMPT`
  - site, url, prompt_text (or hash), dlp_tags, findings summary
- `LOG_EVENT`
  - full event envelope (background finalizes hash chain & upload)
- `GET_CONFIG`
  - request derived config for adapter behavior

### Messages (Background → Content)
- `POLICY_DECISION`
  - decision, rules_fired, message, redactions, require_justification

---

## 10) Backend MVP (UMAI) — Minimal Requirements

### 10.1 `/v1/ext/bootstrap` (GET)
Returns:
- tenant_id
- policy_url
- policy_version
- ingest_url
- public_key_pem + key_id
- server_time_ms

### 10.2 `/v1/ext/policy` (GET)
- returns policy JSON
- supports `ETag`

### 10.3 `/v1/ext/events` (POST)
Accepts:
- batch of event envelopes
Validations:
- auth: `deviceToken` or JWT
- schema validation
- verify hashes and chain continuity
- decrypt payload (if full_content)

Storage:
- append-only `browser_ai_ledger` table
- optional indexing fields (tenant_id, user, site, timestamp, decision)

---

## 11) Testing Plan

### 11.1 Unit Tests
- [ ] Policy engine (first-match wins, explain output)
- [ ] DLP patterns + Luhn/IBAN correctness
- [ ] Hash canonicalization stability
- [ ] Crypto encrypt/decrypt round-trip (test keys)

### 11.2 Integration Tests (Headless Chrome)
- Use Playwright/Puppeteer launching Chrome with extension loaded.
- Script each site:
  - login with test account
  - type prompt
  - submit
  - assert: decision event + response captured + upload ok

### 11.3 Selector Drift / Health
- [ ] Simulate missing selectors → `adapter_health: broken`
- [ ] Ensure extension does not crash or spam the page

---

## 12) MVP Acceptance Criteria Checklist

**Capture**
- [ ] Prompt captured for all 3 sites
- [ ] Final answer captured for all 3 sites (best effort + health fallback)

**Govern**
- [ ] Block secrets
- [ ] Warn/justify for PII
- [ ] Redact IBAN/CC

**Logging**
- [ ] Durable queue, batch uploads
- [ ] Hash chain per device/session
- [ ] metadata_only mode supported end-to-end

**Enterprise**
- [ ] Managed storage config
- [ ] Domain allowlist enforced
- [ ] Clear user transparency UX

---

## 13) Implementation Notes / Guardrails

- Prefer **static content_scripts** to avoid runtime injection complexity.
- Avoid reliance on network body capture in MV3 for MVP.
- Keep selectors resilient: multiple fallbacks + heuristics + health signals.
- Do not store raw prompt/answer locally unless captureMode requires it; always prefer encryption when enabled.
- Ensure governance decisions are **fast** (local scanning + local policy eval; avoid blocking on network).

---

## 14) Starter TODOs for Codex (Top of Queue)

1) Scaffold MV3 TS build → dist
2) Implement managed config loader + schema validation
3) Implement policy fetch/cache + ETag
4) Implement event queue + uploader
5) Implement minimal site adapter for **one** site end-to-end (e.g., ChatGPT)
6) Add DLP + policy engine
7) Add governance modal
8) Replicate adapters to Gemini + Claude

---

## Appendix A — Minimal `manifest.json` Skeleton (example)

```json
{
  "name": "UMAI Browser LLM Governance (MVP)",
  "version": "0.1.0",
  "manifest_version": 3,
  "permissions": ["storage", "tabs"],
  "host_permissions": [
    "https://chatgpt.com/*",
    "https://chat.openai.com/*",
    "https://gemini.google.com/*",
    "https://claude.ai/*"
  ],
  "background": {
    "service_worker": "service_worker.js",
    "type": "module"
  },
  "content_scripts": [
    {
      "matches": ["https://chatgpt.com/*", "https://chat.openai.com/*"],
      "js": ["content_chatgpt.js"],
      "run_at": "document_idle"
    },
    {
      "matches": ["https://gemini.google.com/*"],
      "js": ["content_gemini.js"],
      "run_at": "document_idle"
    },
    {
      "matches": ["https://claude.ai/*"],
      "js": ["content_claude.js"],
      "run_at": "document_idle"
    }
  ],
  "storage": {
    "managed_schema": "schema.json"
  }
}
```

---

## Appendix B — Adapter Interface (TS)

```ts
export type SiteId = "chatgpt" | "gemini" | "claude";

export interface Decision {
  type: "allow" | "warn" | "block" | "redact" | "justify";
  message?: string;
  rulesFired?: string[];
  redactions?: Array<{ start: number; end: number; kind: string }>;
  requireJustification?: boolean;
  minJustificationChars?: number;
}

export interface SiteAdapter {
  siteId: SiteId;
  match(): boolean;

  locateInput(): HTMLElement | null;
  locateSendButton(): HTMLElement | null;
  locateConversationRoot(): HTMLElement | null;

  getPromptText(): string;
  setPromptText(next: string): void;

  interceptSend(cb: (prompt: string) => Promise<Decision>): void;

  captureFinalAnswer(): Promise<string>;
}
```

---

**End of document**

