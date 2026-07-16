/**
 * previewBroadcast — cross-window transport between the Localization
 * Editor and its pop-out preview route.
 *
 * Uses BroadcastChannel where available for zero-latency updates and
 * mirrors every payload to localStorage so a freshly opened pop-out
 * paints the current draft on its first frame (BroadcastChannel does
 * not replay). Both sides listen for `storage` events too, so the
 * fallback is symmetric.
 *
 * Payloads are per-template ({kind, templateCode}) so multiple editors
 * open in the same session never step on each other.
 */

export type PreviewKind = "certificate" | "return";

export interface PreviewPayload {
  kind: PreviewKind;
  templateCode: string;
  body: unknown;
  meta?: unknown;
  displayName?: string | null;
  updatedAt: number;
}

function storageKey(kind: PreviewKind, templateCode: string) {
  return `localization-preview:${kind}:${templateCode}`;
}

function channelName(kind: PreviewKind, templateCode: string) {
  return `localization-preview:${kind}:${templateCode}`;
}

export function publishPreview(payload: PreviewPayload) {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(
      storageKey(payload.kind, payload.templateCode),
      JSON.stringify(payload),
    );
  } catch { /* quota — ignore, channel still fires */ }
  if (typeof BroadcastChannel !== "undefined") {
    try {
      const ch = new BroadcastChannel(channelName(payload.kind, payload.templateCode));
      ch.postMessage(payload);
      ch.close();
    } catch { /* fallback to storage only */ }
  }
}

export function readPreview(kind: PreviewKind, templateCode: string): PreviewPayload | null {
  if (typeof window === "undefined") return null;
  try {
    const raw = window.localStorage.getItem(storageKey(kind, templateCode));
    if (!raw) return null;
    const parsed = JSON.parse(raw) as PreviewPayload;
    if (parsed && typeof parsed === "object" && parsed.templateCode === templateCode) {
      return parsed;
    }
  } catch { /* corrupt entry — ignore */ }
  return null;
}

export function subscribePreview(
  kind: PreviewKind,
  templateCode: string,
  onUpdate: (payload: PreviewPayload) => void,
): () => void {
  if (typeof window === "undefined") return () => {};
  const key = storageKey(kind, templateCode);
  const onStorage = (e: StorageEvent) => {
    if (e.key !== key || !e.newValue) return;
    try {
      const parsed = JSON.parse(e.newValue) as PreviewPayload;
      onUpdate(parsed);
    } catch { /* skip */ }
  };
  window.addEventListener("storage", onStorage);

  let ch: BroadcastChannel | null = null;
  if (typeof BroadcastChannel !== "undefined") {
    try {
      ch = new BroadcastChannel(channelName(kind, templateCode));
      ch.onmessage = (e) => {
        const payload = e.data as PreviewPayload;
        if (payload && typeof payload === "object") onUpdate(payload);
      };
    } catch { ch = null; }
  }

  return () => {
    window.removeEventListener("storage", onStorage);
    if (ch) { try { ch.close(); } catch { /* ignore */ } }
  };
}

export function popOutPreviewUrl(kind: PreviewKind, templateCode: string): string {
  return `/localization/preview/${kind}/${encodeURIComponent(templateCode)}`;
}

/**
 * Open the pop-out preview window, focusing an existing one if any.
 * Returns the child window ref (or null when the browser blocked it).
 */
export function openPreviewWindow(kind: PreviewKind, templateCode: string): Window | null {
  if (typeof window === "undefined") return null;
  const url = popOutPreviewUrl(kind, templateCode);
  const name = `localization-preview-${kind}-${templateCode}`;
  const w = window.open(url, name, "width=960,height=1240,menubar=no,toolbar=no");
  try { w?.focus(); } catch { /* ignore */ }
  return w;
}