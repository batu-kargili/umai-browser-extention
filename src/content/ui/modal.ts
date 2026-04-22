interface ModalOptions {
  title: string;
  message: string;
  details?: string[];
  primaryLabel?: string;
  secondaryLabel?: string;
  textareaLabel?: string;
  textareaPlaceholder?: string;
  textareaMinChars?: number;
  compareBefore?: string;
  compareAfter?: string;
}

interface ModalResult {
  action: "primary" | "secondary" | "dismiss";
  text?: string;
}

let styleInjected = false;

function ensureStyles(): void {
  if (styleInjected) {
    return;
  }
  styleInjected = true;
  const style = document.createElement("style");
  style.id = "umai-modal-style";
  style.textContent = `
    .umai-modal-backdrop {
      position: fixed;
      inset: 0;
      background: rgba(2, 6, 23, 0.65);
      z-index: 2147483647;
      display: flex;
      align-items: center;
      justify-content: center;
      padding: 16px;
    }
    .umai-modal {
      width: min(720px, 100%);
      max-height: 84vh;
      overflow: auto;
      border-radius: 14px;
      border: 1px solid #cbd5e1;
      background: #f8fafc;
      color: #0f172a;
      box-shadow: 0 20px 48px rgba(15, 23, 42, 0.35);
      font-family: Arial, sans-serif;
    }
    .umai-modal-header {
      padding: 16px 18px 10px;
      border-bottom: 1px solid #e2e8f0;
    }
    .umai-modal-header h2 {
      margin: 0;
      font-size: 16px;
      line-height: 1.3;
    }
    .umai-modal-content {
      padding: 14px 18px;
      font-size: 13px;
      line-height: 1.5;
      color: #1e293b;
    }
    .umai-modal-details {
      margin-top: 10px;
      padding-left: 16px;
    }
    .umai-modal-compare {
      margin-top: 12px;
      border: 1px solid #cbd5e1;
      border-radius: 10px;
      background: #ffffff;
      overflow: hidden;
    }
    .umai-modal-compare pre {
      margin: 0;
      padding: 10px 12px;
      font-size: 12px;
      line-height: 1.45;
      white-space: pre-wrap;
      word-break: break-word;
      border-top: 1px solid #e2e8f0;
    }
    .umai-modal-compare-label {
      margin: 0;
      padding: 6px 12px;
      font-size: 11px;
      font-weight: 700;
      letter-spacing: 0.04em;
      text-transform: uppercase;
      background: #f1f5f9;
      color: #334155;
    }
    .umai-modal-textarea {
      margin-top: 10px;
      width: 100%;
      min-height: 100px;
      resize: vertical;
      border: 1px solid #94a3b8;
      border-radius: 10px;
      padding: 8px 10px;
      font: 13px/1.45 Arial, sans-serif;
      color: #0f172a;
      background: #ffffff;
      box-sizing: border-box;
    }
    .umai-modal-footer {
      padding: 12px 18px 16px;
      display: flex;
      justify-content: flex-end;
      gap: 10px;
    }
    .umai-modal-btn {
      border-radius: 9px;
      border: 1px solid #94a3b8;
      background: #ffffff;
      color: #1e293b;
      font: 600 12px/1 Arial, sans-serif;
      padding: 10px 14px;
      cursor: pointer;
    }
    .umai-modal-btn.primary {
      background: #0f172a;
      color: #f8fafc;
      border-color: #0f172a;
    }
    .umai-modal-btn:disabled {
      cursor: not-allowed;
      opacity: 0.5;
    }
  `;
  document.documentElement.appendChild(style);
}

function createModal(options: ModalOptions): Promise<ModalResult> {
  ensureStyles();

  return new Promise((resolve) => {
    const backdrop = document.createElement("div");
    backdrop.className = "umai-modal-backdrop";

    const modal = document.createElement("div");
    modal.className = "umai-modal";

    const header = document.createElement("div");
    header.className = "umai-modal-header";
    const title = document.createElement("h2");
    title.textContent = options.title;
    header.appendChild(title);

    const content = document.createElement("div");
    content.className = "umai-modal-content";
    const message = document.createElement("p");
    message.textContent = options.message;
    content.appendChild(message);

    let textarea: HTMLTextAreaElement | null = null;
    if (options.details && options.details.length > 0) {
      const list = document.createElement("ul");
      list.className = "umai-modal-details";
      for (const item of options.details) {
        const li = document.createElement("li");
        li.textContent = item;
        list.appendChild(li);
      }
      content.appendChild(list);
    }

    if (options.compareBefore !== undefined && options.compareAfter !== undefined) {
      const compare = document.createElement("div");
      compare.className = "umai-modal-compare";

      const beforeLabel = document.createElement("p");
      beforeLabel.className = "umai-modal-compare-label";
      beforeLabel.textContent = "Original";
      compare.appendChild(beforeLabel);

      const beforeText = document.createElement("pre");
      beforeText.textContent = options.compareBefore;
      compare.appendChild(beforeText);

      const afterLabel = document.createElement("p");
      afterLabel.className = "umai-modal-compare-label";
      afterLabel.textContent = "Redacted";
      compare.appendChild(afterLabel);

      const afterText = document.createElement("pre");
      afterText.textContent = options.compareAfter;
      compare.appendChild(afterText);

      content.appendChild(compare);
    }

    if (options.textareaLabel) {
      const label = document.createElement("label");
      label.textContent = options.textareaLabel;
      label.style.display = "block";
      label.style.marginTop = "10px";
      label.style.fontWeight = "700";
      content.appendChild(label);

      textarea = document.createElement("textarea");
      textarea.className = "umai-modal-textarea";
      textarea.placeholder = options.textareaPlaceholder ?? "";
      content.appendChild(textarea);
    }

    const footer = document.createElement("div");
    footer.className = "umai-modal-footer";

    const secondary = document.createElement("button");
    secondary.className = "umai-modal-btn";
    secondary.textContent = options.secondaryLabel ?? "Edit";

    const primary = document.createElement("button");
    primary.className = "umai-modal-btn primary";
    primary.textContent = options.primaryLabel ?? "Proceed";

    const finish = (result: ModalResult) => {
      backdrop.remove();
      resolve(result);
    };

    secondary.addEventListener("click", () => finish({ action: "secondary" }));
    primary.addEventListener("click", () => {
      if (textarea) {
        const value = textarea.value.trim();
        const minChars = options.textareaMinChars ?? 0;
        if (value.length < minChars) {
          textarea.focus();
          return;
        }
        finish({ action: "primary", text: value });
        return;
      }
      finish({ action: "primary" });
    });

    backdrop.addEventListener("click", (event) => {
      if (event.target === backdrop) {
        finish({ action: "dismiss" });
      }
    });

    footer.appendChild(secondary);
    footer.appendChild(primary);

    modal.appendChild(header);
    modal.appendChild(content);
    modal.appendChild(footer);
    backdrop.appendChild(modal);
    document.documentElement.appendChild(backdrop);

    setTimeout(() => {
      primary.focus();
    }, 0);
  });
}

export async function showBlockedModal(message: string, details: string[] = []): Promise<void> {
  await createModal({
    title: "Request blocked by policy",
    message,
    details,
    primaryLabel: "Close",
    secondaryLabel: "Edit"
  });
}

export async function showWarnModal(message: string, details: string[] = []): Promise<boolean> {
  const result = await createModal({
    title: "Policy warning",
    message,
    details,
    primaryLabel: "Proceed",
    secondaryLabel: "Edit"
  });
  return result.action === "primary";
}

export async function showRedactModal(
  message: string,
  original: string,
  redacted: string,
  details: string[] = []
): Promise<boolean> {
  const result = await createModal({
    title: "Sensitive content redaction",
    message,
    details,
    primaryLabel: "Apply and Send",
    secondaryLabel: "Edit",
    compareBefore: original,
    compareAfter: redacted
  });
  return result.action === "primary";
}

export async function showJustificationModal(
  message: string,
  minChars: number,
  details: string[] = []
): Promise<{ proceed: boolean; justification?: string }> {
  const result = await createModal({
    title: "Justification required",
    message,
    details,
    primaryLabel: "Submit",
    secondaryLabel: "Edit",
    textareaLabel: `Justification (${minChars}+ characters)`,
    textareaPlaceholder: "Explain why this prompt should be sent.",
    textareaMinChars: minChars
  });

  if (result.action !== "primary" || !result.text) {
    return { proceed: false };
  }

  return {
    proceed: true,
    justification: result.text
  };
}

