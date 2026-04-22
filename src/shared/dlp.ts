import type { DlpFinding, DlpResult } from "./types";

const SECRET_PATTERNS: Array<{ tag: string; regex: RegExp; confidence: number; weight: number }> = [
  {
    tag: "SECRET_BEARER_TOKEN",
    regex: /\bBearer\s+[A-Za-z0-9\-._~+/]+=*/g,
    confidence: 0.95,
    weight: 8
  },
  {
    tag: "SECRET_PRIVATE_KEY",
    regex: /-----BEGIN\s+(?:RSA|EC|OPENSSH|PGP)?\s*PRIVATE KEY-----[\s\S]+?-----END\s+(?:RSA|EC|OPENSSH|PGP)?\s*PRIVATE KEY-----/g,
    confidence: 0.99,
    weight: 10
  },
  {
    tag: "SECRET_TOKEN",
    regex: /\b(?:sk|api|token)_[A-Za-z0-9]{16,}\b/g,
    confidence: 0.85,
    weight: 7
  }
];

const PII_PATTERNS: Array<{ tag: string; regex: RegExp; confidence: number; weight: number }> = [
  {
    tag: "PII_EMAIL",
    regex: /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g,
    confidence: 0.9,
    weight: 3
  },
  {
    tag: "PII_PHONE",
    regex: /\b(?:\+?\d{1,3}[\s.-]?)?(?:\(?\d{2,4}\)?[\s.-]?)?\d{3,4}[\s.-]?\d{3,4}\b/g,
    confidence: 0.75,
    weight: 2
  }
];

const CREDIT_CARD_REGEX = /\b(?:\d[ -]*?){13,19}\b/g;
const IBAN_REGEX = /\b[A-Z]{2}\d{2}[A-Z0-9]{11,30}\b/g;

function luhnValid(raw: string): boolean {
  const digits = raw.replace(/[^\d]/g, "");
  if (digits.length < 13 || digits.length > 19) {
    return false;
  }
  let sum = 0;
  let shouldDouble = false;
  for (let idx = digits.length - 1; idx >= 0; idx -= 1) {
    let digit = Number(digits[idx]);
    if (Number.isNaN(digit)) {
      return false;
    }
    if (shouldDouble) {
      digit *= 2;
      if (digit > 9) digit -= 9;
    }
    sum += digit;
    shouldDouble = !shouldDouble;
  }
  return sum % 10 === 0;
}

function ibanValid(raw: string): boolean {
  const compact = raw.replace(/\s+/g, "").toUpperCase();
  if (!/^[A-Z]{2}\d{2}[A-Z0-9]+$/.test(compact)) {
    return false;
  }
  const moved = `${compact.slice(4)}${compact.slice(0, 4)}`;
  let expanded = "";
  for (const ch of moved) {
    if (/[A-Z]/.test(ch)) {
      expanded += String(ch.charCodeAt(0) - 55);
    } else {
      expanded += ch;
    }
  }
  let remainder = 0;
  for (const digit of expanded) {
    remainder = (remainder * 10 + Number(digit)) % 97;
  }
  return remainder === 1;
}

function addFinding(
  findings: DlpFinding[],
  tagSet: Set<string>,
  data: { tag: string; start: number; end: number; confidence: number; sample: string }
): void {
  findings.push({
    type: data.tag,
    start: data.start,
    end: data.end,
    confidence: data.confidence,
    sample: data.sample
  });
  tagSet.add(data.tag);
}

function collectPatternFindings(
  text: string,
  definitions: Array<{ tag: string; regex: RegExp; confidence: number; weight: number }>,
  findings: DlpFinding[],
  tagSet: Set<string>
): number {
  let risk = 0;
  for (const definition of definitions) {
    definition.regex.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = definition.regex.exec(text)) !== null) {
      addFinding(findings, tagSet, {
        tag: definition.tag,
        start: match.index,
        end: match.index + match[0].length,
        confidence: definition.confidence,
        sample: match[0].slice(0, 64)
      });
      risk += definition.weight;
    }
  }
  return risk;
}

export function scanTextForDlp(text: string): DlpResult {
  const findings: DlpFinding[] = [];
  const tags = new Set<string>();
  let riskScore = 0;

  riskScore += collectPatternFindings(text, SECRET_PATTERNS, findings, tags);
  riskScore += collectPatternFindings(text, PII_PATTERNS, findings, tags);

  CREDIT_CARD_REGEX.lastIndex = 0;
  let cardMatch: RegExpExecArray | null;
  while ((cardMatch = CREDIT_CARD_REGEX.exec(text)) !== null) {
    const value = cardMatch[0];
    if (!luhnValid(value)) {
      continue;
    }
    addFinding(findings, tags, {
      tag: "PII_CREDITCARD",
      start: cardMatch.index,
      end: cardMatch.index + value.length,
      confidence: 0.9,
      sample: value.slice(0, 32)
    });
    riskScore += 6;
  }

  IBAN_REGEX.lastIndex = 0;
  let ibanMatch: RegExpExecArray | null;
  while ((ibanMatch = IBAN_REGEX.exec(text)) !== null) {
    const value = ibanMatch[0];
    if (!ibanValid(value)) {
      continue;
    }
    const ibanTag = value.startsWith("TR") ? "PII_IBAN_TR" : "PII_IBAN";
    addFinding(findings, tags, {
      tag: ibanTag,
      start: ibanMatch.index,
      end: ibanMatch.index + value.length,
      confidence: 0.88,
      sample: value.slice(0, 32)
    });
    riskScore += 5;
  }

  return {
    tags: Array.from(tags.values()).sort(),
    findings,
    riskScore
  };
}

