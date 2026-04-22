import type { SiteId } from "../shared/types";
import type { SiteSelectors } from "./dom/selectors";

type EditableElement = HTMLTextAreaElement | HTMLInputElement | HTMLElement;

export interface SiteAdapter {
  siteId: SiteId;
  locateInput(): EditableElement | null;
  locateSendButton(): HTMLElement | null;
  locateConversationRoot(): HTMLElement | null;
  locateAssistantMessages(): HTMLElement[];
  getPromptText(): string;
  setPromptText(next: string): void;
  submitPrompt(): void;
}

function queryFirst(selectors: string[]): HTMLElement | null {
  for (const selector of selectors) {
    const node = document.querySelector(selector);
    if (node instanceof HTMLElement) {
      return node;
    }
  }
  return null;
}

function editableFromElement(element: EditableElement): string {
  if (element instanceof HTMLTextAreaElement || element instanceof HTMLInputElement) {
    return element.value;
  }
  return (element.textContent ?? "").trim();
}

function setEditableValue(element: EditableElement, next: string): void {
  if (element instanceof HTMLTextAreaElement || element instanceof HTMLInputElement) {
    element.value = next;
    element.dispatchEvent(new Event("input", { bubbles: true }));
    return;
  }
  element.textContent = next;
  element.dispatchEvent(new InputEvent("input", { bubbles: true, data: next }));
}

export function createSiteAdapter(siteId: SiteId, selectors: SiteSelectors): SiteAdapter {
  return {
    siteId,
    locateInput(): EditableElement | null {
      const node = queryFirst(selectors.input);
      if (!node) {
        return null;
      }
      if (
        node instanceof HTMLTextAreaElement ||
        node instanceof HTMLInputElement ||
        node.isContentEditable
      ) {
        return node;
      }
      return null;
    },

    locateSendButton(): HTMLElement | null {
      return queryFirst(selectors.sendButton);
    },

    locateConversationRoot(): HTMLElement | null {
      return queryFirst(selectors.conversationRoot);
    },

    locateAssistantMessages(): HTMLElement[] {
      const results: HTMLElement[] = [];
      for (const selector of selectors.assistantMessage) {
        const nodes = Array.from(document.querySelectorAll(selector));
        for (const node of nodes) {
          if (node instanceof HTMLElement && node.innerText.trim().length > 0) {
            results.push(node);
          }
        }
      }
      return results;
    },

    getPromptText(): string {
      const input = this.locateInput();
      if (!input) {
        return "";
      }
      return editableFromElement(input).trim();
    },

    setPromptText(next: string): void {
      const input = this.locateInput();
      if (!input) {
        return;
      }
      setEditableValue(input, next);
    },

    submitPrompt(): void {
      const sendButton = this.locateSendButton();
      if (sendButton) {
        sendButton.click();
        return;
      }
      const input = this.locateInput();
      if (!input) {
        return;
      }
      input.dispatchEvent(
        new KeyboardEvent("keydown", {
          key: "Enter",
          bubbles: true,
          cancelable: true
        })
      );
    }
  };
}

