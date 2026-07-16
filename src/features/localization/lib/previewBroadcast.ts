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

/**
 * Kinds of localization artefacts that can broadcast a live preview to a
 * pop-out window. Extend cautiously — the pop-out route reads this via
 * `LocalizationPreviewWindow` and must know how to render each kind.
 */
export type PreviewKind =
  | "certificate"
  | "return"
  | "bank-export"
  | "garnishment"
  | "token-registry"
  | "statutory-authority"
  | "pack-requirements"
  | "publisher-governance";

export interface PreviewPayload {
  kind: PreviewKind;
  templateCode: string;
  body: unknown;
  meta?: unknown;
  displayName?: string | null;
  updatedAt: number;
}

/**
 * Heartbeat envelope — the editor emits this every ~5s so the pop-out
 * can distinguish "editor still open, no edits" from "editor closed".
 * Payload does not carry `body`; consumers keep the last real payload.
 */
export interface PreviewHeartbeat {
  __kind: "heartbeat";
  kind: PreviewKind;
  templateCode: string;
  at: number;
}

export type PreviewMessage = PreviewPayload | PreviewHeartbeat;

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

/**
 * Clear the persisted preview payload for a given (kind, templateCode).
 * The editor calls this on unmount so a freshly opened pop-out for the
 * SAME template does not flash the previous session's stale draft
 * before the first live update arrives.
 */
export function clearPreview(kind: PreviewKind, templateCode: string) {
  if (typeof window === "undefined") return;
  try { window.localStorage.removeItem(storageKey(kind, templateCode)); } catch { /* ignore */ }
  if (typeof BroadcastChannel !== "undefined") {
    try {
      const ch = new BroadcastChannel(channelName(kind, templateCode));
      const msg: PreviewHeartbeat = { __kind: "heartbeat", kind, templateCode, at: -1 };
      ch.postMessage(msg);
      ch.close();
    } catch { /* ignore */ }
  }
}

/**
 * Emit a heartbeat so a pop-out can display "Editor closed" when the
 * heartbeat stops. Cheap — no `body` payload, only a timestamp.
 */
export function publishPreviewHeartbeat(kind: PreviewKind, templateCode: string) {
  if (typeof window === "undefined") return;
  if (typeof BroadcastChannel === "undefined") return;
  try {
    const ch = new BroadcastChannel(channelName(kind, templateCode));
    const msg: PreviewHeartbeat = { __kind: "heartbeat", kind, templateCode, at: Date.now() };
    ch.postMessage(msg);
    ch.close();
  } catch { /* ignore */ }
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
  onHeartbeat?: (h: PreviewHeartbeat) => void,
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
        const msg = e.data as PreviewMessage;
        if (!msg || typeof msg !== "object") return;
        if ((msg as PreviewHeartbeat).__kind === "heartbeat") {
          onHeartbeat?.(msg as PreviewHeartbeat);
        } else {
          onUpdate(msg as PreviewPayload);
        }
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