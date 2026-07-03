// Message bridge to the overlay script running inside the canvas iframe
// (FR-2.2). The Canvas registers its iframe; anyone can send commands.

type OverlayCommand =
  | { type: "select-id"; id: string }
  | { type: "clear" };

let iframe: HTMLIFrameElement | null = null;

export function registerCanvasIframe(el: HTMLIFrameElement | null) {
  iframe = el;
}

export function sendToOverlay(cmd: OverlayCommand) {
  iframe?.contentWindow?.postMessage({ __dedup: true, ...cmd }, "*");
}
