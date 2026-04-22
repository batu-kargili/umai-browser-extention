import type { SiteId } from "../../shared/types";

export interface SiteSelectors {
  input: string[];
  sendButton: string[];
  conversationRoot: string[];
  assistantMessage: string[];
}

export const SITE_SELECTORS: Record<SiteId, SiteSelectors> = {
  chatgpt: {
    input: [
      "#prompt-textarea",
      "textarea[data-testid='chat-input']",
      "textarea"
    ],
    sendButton: [
      "button[data-testid='send-button']",
      "button[aria-label*='Send']",
      "button[type='submit']"
    ],
    conversationRoot: [
      "main",
      "[data-testid='conversation-turns']"
    ],
    assistantMessage: [
      "[data-message-author-role='assistant']",
      "article [data-testid='markdown']",
      "article div.markdown"
    ]
  },
  gemini: {
    input: [
      "textarea",
      "div[contenteditable='true'][role='textbox']",
      "div[contenteditable='true']"
    ],
    sendButton: [
      "button[aria-label*='Send']",
      "button[aria-label*='submit']",
      "button[type='submit']"
    ],
    conversationRoot: [
      "main",
      "body"
    ],
    assistantMessage: [
      "message-content",
      "[data-message-author='model']",
      "div.markdown"
    ]
  },
  claude: {
    input: [
      "div[contenteditable='true'][data-placeholder]",
      "div[contenteditable='true'][role='textbox']",
      "textarea"
    ],
    sendButton: [
      "button[aria-label*='Send']",
      "button[aria-label*='send']",
      "button[type='submit']"
    ],
    conversationRoot: [
      "main",
      "body"
    ],
    assistantMessage: [
      "[data-testid='assistant-message']",
      "[data-message-author='assistant']",
      "div.markdown"
    ]
  }
};

