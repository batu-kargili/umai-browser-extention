function byId<T extends HTMLElement>(id: string): T {
  const element = document.getElementById(id);
  if (!element) {
    throw new Error(`Missing blocked page element: ${id}`);
  }
  return element as T;
}

function decodeApprovedDomains(raw: string | null): string[] {
  if (!raw) {
    return [];
  }
  return raw
    .split(",")
    .map((value) => value.trim().toLowerCase())
    .filter((value, index, all) => value.length > 0 && all.indexOf(value) === index);
}

function renderApprovedDomains(domains: string[]): void {
  const container = byId<HTMLDivElement>("approvedLinks");
  const emptyState = byId<HTMLParagraphElement>("emptyApproved");
  container.replaceChildren();

  if (domains.length === 0) {
    emptyState.hidden = false;
    return;
  }

  emptyState.hidden = true;
  for (const domain of domains) {
    const link = document.createElement("a");
    link.href = `https://${domain}/`;
    link.className = "approved-link";
    link.rel = "noreferrer";

    const label = document.createElement("span");
    label.textContent = domain;
    link.appendChild(label);

    const arrow = document.createElement("span");
    arrow.textContent = "Open";
    link.appendChild(arrow);

    container.appendChild(link);
  }
}

function init(): void {
  const params = new URLSearchParams(window.location.search);
  const blockedHost = params.get("host") ?? "Unapproved AI site";
  const blockedUrl = params.get("blocked") ?? "Unknown URL";
  const mode = params.get("mode") ?? "enforce";
  const reason =
    params.get("reason") ??
    "This AI site is not approved by your organization. Use an approved assistant instead.";

  byId("blockedHost").textContent = blockedHost;
  byId("blockedUrl").textContent = blockedUrl;
  byId("guardMode").textContent =
    mode === "fail-closed"
      ? "Fail-closed until organization connection is completed"
      : mode === "audit"
      ? "Audit-only monitoring"
      : "Enforced blocking";
  byId("policyReason").textContent = reason;

  renderApprovedDomains(decodeApprovedDomains(params.get("approved")));
}

document.addEventListener("DOMContentLoaded", init);
