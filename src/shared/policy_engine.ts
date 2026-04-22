import type { Decision, DlpResult, PolicyPack, PolicyRule } from "./types";
import { applyRedactionsToText, findingsToRedactionSpans } from "./redact";

const DEFAULT_POLICY_PACK: PolicyPack = {
  version: "default-local-allow",
  default_action: "allow",
  rules: []
};

export function getDefaultPolicyPack(): PolicyPack {
  return DEFAULT_POLICY_PACK;
}

function matchesRule(rule: PolicyRule, dlp: DlpResult): boolean {
  const requiredTags = rule.match.dlp_tags_any;
  if (requiredTags && requiredTags.length > 0) {
    return requiredTags.some((tag) => dlp.tags.includes(tag));
  }
  return false;
}

function defaultDecision(dlp: DlpResult, action: Decision["type"]): Decision {
  return {
    type: action,
    message: undefined,
    rulesFired: [],
    dlpTags: dlp.tags,
    redactions: [],
    requireJustification: action === "justify",
    minJustificationChars: action === "justify" ? 10 : undefined
  };
}

export function evaluatePromptPolicy(
  promptText: string,
  dlp: DlpResult,
  policyPack?: PolicyPack
): Decision {
  const policy = policyPack ?? DEFAULT_POLICY_PACK;

  for (const rule of policy.rules) {
    if (!rule.enabled || !matchesRule(rule, dlp)) {
      continue;
    }

    const base: Decision = {
      type: rule.action.type,
      message: rule.message,
      rulesFired: [rule.id],
      dlpTags: dlp.tags,
      redactions: [],
      requireJustification: rule.action.type === "justify",
      minJustificationChars: rule.action.min_chars
    };

    if (rule.action.type === "redact") {
      const redactions = findingsToRedactionSpans(dlp.findings);
      return {
        ...base,
        redactions,
        redactedText: applyRedactionsToText(promptText, redactions, rule.action.strategy ?? "mask")
      };
    }

    return base;
  }

  return defaultDecision(dlp, policy.default_action);
}

