let styleInjected = false;
let toastRoot: HTMLDivElement | null = null;

function ensureStyle(): void {
  if (styleInjected) {
    return;
  }
  styleInjected = true;
  const style = document.createElement("style");
  style.id = "umai-extension-style";
  style.textContent = `
    .umai-toast-root {
      position: fixed;
      top: 16px;
      right: 16px;
      z-index: 2147483647;
      display: flex;
      flex-direction: column;
      gap: 8px;
      pointer-events: none;
    }
    .umai-toast {
      max-width: 360px;
      border-radius: 10px;
      border: 1px solid #1e293b;
      background: #0f172a;
      color: #f8fafc;
      box-shadow: 0 12px 32px rgba(15, 23, 42, 0.35);
      padding: 10px 12px;
      font: 600 12px/1.4 Arial, sans-serif;
      letter-spacing: 0.01em;
      pointer-events: auto;
    }
    .umai-toast.warn {
      border-color: #f59e0b;
      background: #78350f;
    }
    .umai-toast.block {
      border-color: #ef4444;
      background: #7f1d1d;
    }
    .umai-toast.ok {
      border-color: #22c55e;
      background: #14532d;
    }
  `;
  document.documentElement.appendChild(style);
}

function ensureRoot(): HTMLDivElement {
  ensureStyle();
  if (!toastRoot) {
    toastRoot = document.createElement("div");
    toastRoot.className = "umai-toast-root";
    document.documentElement.appendChild(toastRoot);
  }
  return toastRoot;
}

export function showToast(message: string, tone: "ok" | "warn" | "block" = "ok"): void {
  const root = ensureRoot();
  const item = document.createElement("div");
  item.className = `umai-toast ${tone}`;
  item.textContent = message;
  root.appendChild(item);
  setTimeout(() => {
    item.remove();
  }, 3200);
}

