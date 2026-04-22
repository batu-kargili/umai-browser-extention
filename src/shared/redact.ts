import type { DlpFinding } from "./types";

export interface RedactionSpan {
  start: number;
  end: number;
  kind: string;
}

export function findingsToRedactionSpans(findings: DlpFinding[]): RedactionSpan[] {
  const sorted = [...findings]
    .map((finding) => ({ start: finding.start, end: finding.end, kind: finding.type }))
    .sort((a, b) => a.start - b.start || a.end - b.end);

  const merged: RedactionSpan[] = [];
  for (const span of sorted) {
    const last = merged[merged.length - 1];
    if (!last || span.start > last.end) {
      merged.push(span);
      continue;
    }
    if (span.end > last.end) {
      last.end = span.end;
    }
    if (!last.kind.includes(span.kind)) {
      last.kind = `${last.kind}|${span.kind}`;
    }
  }
  return merged;
}

export function applyRedactionsToText(
  original: string,
  redactions: RedactionSpan[],
  strategy: "mask" | "token" = "mask"
): string {
  if (redactions.length === 0) {
    return original;
  }
  const sorted = [...redactions].sort((a, b) => b.start - a.start);
  let next = original;
  for (const redaction of sorted) {
    const replacement =
      strategy === "token"
        ? "[REDACTED]"
        : `[REDACTED:${redaction.kind.split("|")[0] ?? "SENSITIVE"}]`;
    next = `${next.slice(0, redaction.start)}${replacement}${next.slice(redaction.end)}`;
  }
  return next;
}

