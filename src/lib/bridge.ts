// Message bridge to the overlay script running inside the canvas iframe
// (FR-2.2). The Canvas registers its iframe; anyone can send commands.

type OverlayCommand =
  | { type: "select-id"; id: string }
  | { type: "clear" }
  | { type: "set-class"; id: string; className: string }
  | { type: "reset-class"; id: string; className?: string }
  | { type: "clear-staged" }
  | { type: "list-files" }
  | { type: "set-mode"; mode: "inspect" | "browse" };

let iframe: HTMLIFrameElement | null = null;

export function registerCanvasIframe(el: HTMLIFrameElement | null) {
  iframe = el;
}

export function sendToOverlay(cmd: OverlayCommand) {
  iframe?.contentWindow?.postMessage({ __dedup: true, ...cmd }, "*");
}

/** Source files behind the elements currently on the canvas (FR-5.1 canvas
 * scope). Resolves null when there's no canvas or the overlay doesn't answer
 * (dev server down, untagged project) — callers fall back to a full scan. */
export function requestCanvasFiles(timeoutMs = 1500): Promise<string[] | null> {
  if (!iframe?.contentWindow) return Promise.resolve(null);
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      window.removeEventListener("message", onMessage);
      resolve(null);
    }, timeoutMs);
    function onMessage(e: MessageEvent) {
      const m = e.data;
      if (!m || m.__dedup !== true || m.type !== "files") return;
      clearTimeout(timer);
      window.removeEventListener("message", onMessage);
      resolve(Array.isArray(m.files) ? m.files : null);
    }
    window.addEventListener("message", onMessage);
    sendToOverlay({ type: "list-files" });
  });
}
