# Umai Extension MVP

Chrome Extension (Manifest V3) for enterprise governance of browser-based AI usage on:

- ChatGPT (`chatgpt.com`, `chat.openai.com`)
- Gemini (`gemini.google.com`)
- Claude (`claude.ai`)

The extension captures prompt/response activity, enforces local policy decisions at submit time, blocks Shadow AI navigation at the browser layer, and uploads tamper-evident events to UMAI ingest.

## What is implemented

- Managed config via `chrome.storage.managed` (`schema.json`)
- Browser guardrails for Shadow AI domains with fail-closed enforcement before page use
- Prompt governance decisions: `allow`, `warn`, `block`, `redact`, `justify`
- Local DLP scanning (secrets, email, phone, credit card/Luhn, IBAN)
- Policy engine with first-match-wins semantics
- Response capture with DOM mutation stability window
- Hash-chained event envelopes
- Durable local queue with background retry uploader
- Site adapters for ChatGPT, Gemini, Claude
- Auth0-based organization connect flow via Control Center page

## Project layout

```text
src/
  background/
    service_worker.ts
    config.ts
    browser_security.ts
    policy_cache.ts
    events.ts
    queue.ts
    uploader.ts
    auth.ts
  blocked/
    blocked.ts
    blocked.html
  popup/
    popup.ts
    popup.html
  content/
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
  shared/
    types.ts
    dlp.ts
    policy_engine.ts
    redact.ts
    hash.ts
manifest.json
schema.json
```

## Commands

```bash
npm install
npm run typecheck
npm run build
```

Built extension output is created in `dist/`.

## Load in Chrome

1. Open `chrome://extensions`
2. Enable `Developer mode`
3. Click `Load unpacked`
4. Select the `dist/` directory

Then click the extension icon and choose `Connect Organization`.
This opens Control Center (`/extension/connect`), where the logged-in Auth0 user can push tenant config into the extension automatically.

## User connect flow (Auth0)

1. User logs into Control Center with Auth0.
2. User opens extension popup and clicks `Connect Organization`.
3. Control Center resolves the user’s org/tenant and calls the extension through `chrome.runtime.sendMessage`.
4. Extension stores the org config in local extension storage and starts uploading events for that tenant.

No DevTools, no manual registry editing, no inspect console commands for end users.

## Managed configuration fields

Defined in `schema.json`:

- `tenantId` (required)
- `environment` (`prod` or `stage`, required)
- `ingestBaseUrl` (required)
- `eventsUrl` (optional explicit ingest endpoint for deployments that do not use `/v1/ext/events`)
- `policyUrl` (required)
- `controlCenterUrl` (optional)
- `deviceToken` (required)
- `deviceId` (optional)
- `captureMode` (`metadata_only` or `full_content`)
- `retentionLocalDays`
- `debug`
- `allowedDomains`
- `browserSecurity`
  - `enabled`
  - `mode` (`audit` or `enforce`)
  - `shadowAiDomains`

Example:

```json
{
  "tenantId": "00000000-0000-0000-0000-000000000001",
  "environment": "prod",
  "ingestBaseUrl": "https://umai.example.com",
  "eventsUrl": "https://umai.example.com/v1/ext/events",
  "policyUrl": "https://umai.example.com/v1/ext/policy",
  "controlCenterUrl": "https://umai-controlcenter.example.com",
  "deviceToken": "device-token-from-admin",
  "captureMode": "metadata_only",
  "retentionLocalDays": 7,
  "debug": false,
  "browserSecurity": {
    "enabled": true,
    "mode": "enforce",
    "shadowAiDomains": ["copilot.microsoft.com", "perplexity.ai", "poe.com"]
  }
}
```

`allowedDomains` remains the explicit approval list. Browser security treats any known AI domain outside that list as Shadow AI and either logs it (`audit`) or redirects the tab to the UMAI blocked page (`enforce`). When the extension is not connected to an organization, known AI sites are blocked fail-closed until connect completes.

## Policy pack format

Example policy response from `policyUrl`:

```json
{
  "version": "2026-02-24.1",
  "default_action": "allow",
  "rules": [
    {
      "id": "block_secrets",
      "enabled": true,
      "match": { "dlp_tags_any": ["SECRET_TOKEN", "SECRET_PRIVATE_KEY"] },
      "action": { "type": "block" },
      "message": "Sensitive secret detected. Remove credentials before sending."
    },
    {
      "id": "justify_pii",
      "enabled": true,
      "match": { "dlp_tags_any": ["PII_EMAIL", "PII_PHONE"] },
      "action": { "type": "justify", "min_chars": 10 },
      "message": "Possible PII detected. Add justification to proceed."
    },
    {
      "id": "redact_financial",
      "enabled": true,
      "match": { "dlp_tags_any": ["PII_CREDITCARD", "PII_IBAN", "PII_IBAN_TR"] },
      "action": { "type": "redact", "strategy": "mask" },
      "message": "Financial identifier detected and will be redacted."
    }
  ]
}
```

## Notes

- This is an MVP with UI-layer capture and selector-based adapters.
- Browser guardrails run on tab navigation, so unmanaged AI sites are blocked before prompt submission.
- Selector drift can degrade capture quality when provider UIs change.
- Network payload interception is intentionally not used.
- Managed policy remains supported for centrally enforced enterprise rollout.
