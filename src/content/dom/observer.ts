interface StableObserverOptions {
  root: HTMLElement;
  stabilityMs?: number;
  getLatestText: () => string;
  onStable: (text: string) => void;
}

export function observeStableAssistantText(options: StableObserverOptions): () => void {
  const stabilityMs = options.stabilityMs ?? 1200;
  let timeoutId: number | null = null;
  let lastSeen = "";
  let lastEmitted = "";

  const schedule = () => {
    const next = options.getLatestText().trim();
    if (!next || next === lastSeen) {
      return;
    }
    lastSeen = next;
    if (timeoutId !== null) {
      window.clearTimeout(timeoutId);
    }
    timeoutId = window.setTimeout(() => {
      if (lastSeen && lastSeen !== lastEmitted) {
        lastEmitted = lastSeen;
        options.onStable(lastSeen);
      }
    }, stabilityMs);
  };

  const observer = new MutationObserver(() => {
    schedule();
  });

  observer.observe(options.root, {
    subtree: true,
    childList: true,
    characterData: true
  });

  schedule();

  return () => {
    observer.disconnect();
    if (timeoutId !== null) {
      window.clearTimeout(timeoutId);
    }
  };
}

