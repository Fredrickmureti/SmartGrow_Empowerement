/**
 * SafePdfViewer — the single, Electron-aware PDF preview surface for the
 * entire app (ADR-0015, Phases F and re-audit follow-up).
 *
 * Why this exists
 * ---------------
 * Every previous preview dialog mounted a raw `<iframe src={blobUrl}>` (or
 * `<iframe src={signedUrl}>`) to display a server-generated PDF. That works
 * in real browsers and our PWA, but in a packaged Electron build it depends
 * on a fragile combination of (a) Chromium's PDF plugin being registered
 * inside the renderer and (b) the CSP allowing the source URL inside
 * `frame-src`. When either condition silently breaks the user gets a
 * permanently blank pane with no recovery affordance.
 *
 * This component eliminates that failure mode:
 *
 *   - In Electron (`window.pos.isElectron === true`), we do NOT mount an
 *     iframe at all. The PDF bytes are handed to the `preview:open-pdf`
 *     IPC and rendered in a dedicated, lifecycle-supervised
 *     `BrowserWindow` that loads them as `file://…/preview.pdf`.
 *     Chromium's native viewer is reliable on that path. The dialog
 *     itself shows a state card with Reopen / Download / Retry actions.
 *
 *   - In a real browser / PWA, we render the iframe (matching the original
 *     behaviour) but instrument it with `onLoad`, `onError`, and a 5 s
 *     safety timer. If anything goes wrong we surface the same recovery
 *     card with "Open in new tab" / "Download" so the preview can never
 *     silently fail.
 *
 * Inputs
 * ------
 * The viewer accepts EITHER:
 *   - `pdfBlob` — the canonical path used by all server-generated previews
 *     (invoices, reports, payroll registers, POS receipts), or
 *   - `pdfUrl`  — a same-origin or signed remote URL (used by the HR
 *     Employee Documents tab, where the PDF lives in Supabase storage).
 *
 * The two are mutually exclusive. URL-mode never calls
 * `URL.createObjectURL`; the URL is owned by the caller.
 *
 * Every PDF preview surface in the app must funnel through this component.
 * A custom ESLint rule (`eslint-rules/no-direct-pdf-iframe.js`) and an
 * architecture test prevent regressions to raw blob / PDF iframes.
 */

import { useEffect, useMemo, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import {
  Loader2,
  ExternalLink,
  RefreshCw,
  Download,
  AlertCircle,
  FileText,
} from "lucide-react";
import {
  isElectron as runtimeIsElectron,
  openPdfPreview,
} from "@/services/printing/previewSurface";
import { downloadPdfBlob } from "@/services/printing/pdfUtils";

export interface SafePdfViewerProps {
  /**
   * The PDF blob to preview. `null` keeps the viewer in its loading skeleton
   * so parent dialogs don't have to render two branches themselves.
   * Mutually exclusive with `pdfUrl`.
   */
  pdfBlob?: Blob | null;
  /**
   * Remote / signed-URL source for the PDF (e.g. Supabase storage signed URL).
   * Mutually exclusive with `pdfBlob`.
   */
  pdfUrl?: string | null;
  /** Window/tab title shown to the user. */
  title?: string;
  /** Suggested filename for download / dedicated viewer window. */
  filename?: string;
  /** Optional className applied to the outer wrapper. */
  className?: string;
  /** Explicit loading state from the parent (e.g. PDF still generating). */
  isLoading?: boolean;
  /** Optional inline message rendered above the viewer (e.g. paper format). */
  caption?: React.ReactNode;
}

type ViewerState =
  | { kind: "loading" }
  | { kind: "iframe"; url: string }
  | { kind: "iframe-failed"; url: string; reason: string }
  | { kind: "electron-opening" }
  | { kind: "electron-opened" }
  | { kind: "electron-failed"; reason: string };

const IFRAME_LOAD_TIMEOUT_MS = 5000;

export function SafePdfViewer({
  pdfBlob,
  pdfUrl,
  title,
  filename = "document",
  className,
  isLoading,
  caption,
}: SafePdfViewerProps) {
  const isElectron = useMemo(() => runtimeIsElectron(), []);
  const [state, setState] = useState<ViewerState>({ kind: "loading" });
  // Owned-by-this-component blob URL. Only ever non-null in blob+web mode.
  const blobUrlRef = useRef<string | null>(null);
  const iframeLoadedRef = useRef(false);

  // Derive a stable source identity so the effect re-runs only when the
  // actual input changes, not on every parent re-render.
  const source = useMemo<{ kind: "blob"; blob: Blob } | { kind: "url"; url: string } | null>(() => {
    if (pdfBlob) return { kind: "blob", blob: pdfBlob };
    if (pdfUrl) return { kind: "url", url: pdfUrl };
    return null;
  }, [pdfBlob, pdfUrl]);

  useEffect(() => {
    iframeLoadedRef.current = false;

    if (isLoading || !source) {
      setState({ kind: "loading" });
      if (blobUrlRef.current) {
        try { URL.revokeObjectURL(blobUrlRef.current); } catch { /* ignore */ }
        blobUrlRef.current = null;
      }
      return;
    }

    let cancelled = false;

    if (isElectron) {
      // Electron path — fetch bytes (from URL or blob) and hand to the
      // dedicated viewer window via IPC. Never mount an iframe.
      setState({ kind: "electron-opening" });
      (async () => {
        try {
          const blob =
            source.kind === "blob"
              ? source.blob
              : await fetchUrlAsPdfBlob(source.url);
          if (cancelled) return;
          const res = await openPdfPreview(blob, { title, filename });
          if (cancelled) return;
          if (res.ok) setState({ kind: "electron-opened" });
          else setState({ kind: "electron-failed", reason: res.error || "Unknown error" });
        } catch (err) {
          if (cancelled) return;
          setState({
            kind: "electron-failed",
            reason: err instanceof Error ? err.message : String(err),
          });
        }
      })();
      return () => {
        cancelled = true;
      };
    }

    // Web / PWA path — resolve a URL the iframe can render.
    let url: string;
    if (source.kind === "blob") {
      url = URL.createObjectURL(source.blob);
      blobUrlRef.current = url;
    } else {
      url = source.url;
    }
    setState({ kind: "iframe", url });

    // Safety timeout: if the iframe never fires `load` within 5 s, the
    // plugin is almost certainly blocked. Surface the recovery card.
    const timer = window.setTimeout(() => {
      if (!iframeLoadedRef.current) {
        setState({
          kind: "iframe-failed",
          url,
          reason: "Preview did not load within 5 seconds",
        });
      }
    }, IFRAME_LOAD_TIMEOUT_MS);

    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [source, isLoading, isElectron, title, filename]);

  // Final unmount cleanup — revoke any outstanding blob URL.
  useEffect(() => {
    return () => {
      if (blobUrlRef.current) {
        try { URL.revokeObjectURL(blobUrlRef.current); } catch { /* ignore */ }
        blobUrlRef.current = null;
      }
    };
  }, []);

  const handleReopen = async () => {
    if (!source) return;
    setState({ kind: "electron-opening" });
    try {
      const blob =
        source.kind === "blob" ? source.blob : await fetchUrlAsPdfBlob(source.url);
      const res = await openPdfPreview(blob, { title, filename });
      if (res.ok) setState({ kind: "electron-opened" });
      else setState({ kind: "electron-failed", reason: res.error || "Unknown error" });
    } catch (err) {
      setState({
        kind: "electron-failed",
        reason: err instanceof Error ? err.message : String(err),
      });
    }
  };

  const handleOpenInTab = () => {
    if (source?.kind === "url") {
      window.open(source.url, "_blank", "noopener,noreferrer");
      return;
    }
    if (!blobUrlRef.current && source?.kind === "blob") {
      blobUrlRef.current = URL.createObjectURL(source.blob);
    }
    if (blobUrlRef.current) {
      window.open(blobUrlRef.current, "_blank", "noopener,noreferrer");
    }
  };

  const handleDownload = async () => {
    if (!source) return;
    const blob =
      source.kind === "blob"
        ? source.blob
        : await fetchUrlAsPdfBlob(source.url).catch(() => null);
    if (blob) downloadPdfBlob(blob, `${filename || "document"}.pdf`);
  };

  const wrapperClass =
    className ??
    "w-full h-full min-h-[250px] sm:min-h-[400px] bg-background rounded-lg border overflow-hidden flex flex-col";

  return (
    <div className={wrapperClass}>
      {caption ? (
        <div className="px-4 py-2 border-b text-xs text-muted-foreground bg-muted/30">
          {caption}
        </div>
      ) : null}

      <div className="flex-1 min-h-0 relative">
        {state.kind === "loading" && (
          <CenterCard>
            <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
            <span className="text-sm text-muted-foreground">Generating preview…</span>
          </CenterCard>
        )}

        {state.kind === "iframe" && (
          <iframe
            // eslint-disable-next-line local/no-direct-pdf-iframe -- canonical viewer
            src={state.url}
            title={title || "PDF preview"}
            className="w-full h-full"
            style={{ border: "none", minHeight: 400 }}
            onLoad={() => {
              iframeLoadedRef.current = true;
            }}
            onError={() =>
              setState({
                kind: "iframe-failed",
                url: state.url,
                reason: "Browser refused to render the PDF inline",
              })
            }
          />
        )}

        {state.kind === "iframe-failed" && (
          <CenterCard>
            <AlertCircle className="h-8 w-8 text-amber-500" />
            <div className="text-sm font-medium">Inline preview unavailable</div>
            <div className="text-xs text-muted-foreground max-w-sm text-center">
              {state.reason}. You can still open the document in a new tab or download it.
            </div>
            <div className="flex gap-2 pt-2">
              <Button size="sm" variant="outline" onClick={handleOpenInTab}>
                <ExternalLink className="h-3.5 w-3.5 mr-2" />
                Open in new tab
              </Button>
              <Button size="sm" variant="outline" onClick={handleDownload}>
                <Download className="h-3.5 w-3.5 mr-2" />
                Download
              </Button>
            </div>
          </CenterCard>
        )}

        {state.kind === "electron-opening" && (
          <CenterCard>
            <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
            <span className="text-sm text-muted-foreground">
              Opening preview in a separate window…
            </span>
          </CenterCard>
        )}

        {state.kind === "electron-opened" && (
          <CenterCard>
            <FileText className="h-10 w-10 text-primary" />
            <div className="text-sm font-medium">Preview opened in a separate window</div>
            <div className="text-xs text-muted-foreground max-w-sm text-center">
              The PDF is being displayed in a dedicated preview window for the best rendering
              quality. Use the actions below if it was closed or you need another copy.
            </div>
            <div className="flex gap-2 pt-2">
              <Button size="sm" variant="outline" onClick={handleReopen}>
                <RefreshCw className="h-3.5 w-3.5 mr-2" />
                Reopen preview
              </Button>
              <Button size="sm" variant="outline" onClick={handleDownload}>
                <Download className="h-3.5 w-3.5 mr-2" />
                Download
              </Button>
            </div>
          </CenterCard>
        )}

        {state.kind === "electron-failed" && (
          <CenterCard>
            <AlertCircle className="h-8 w-8 text-destructive" />
            <div className="text-sm font-medium">Could not open preview window</div>
            <div className="text-xs text-muted-foreground max-w-sm text-center">
              {state.reason}
            </div>
            <div className="flex gap-2 pt-2">
              <Button size="sm" variant="outline" onClick={handleReopen}>
                <RefreshCw className="h-3.5 w-3.5 mr-2" />
                Retry
              </Button>
              <Button size="sm" variant="outline" onClick={handleDownload}>
                <Download className="h-3.5 w-3.5 mr-2" />
                Download instead
              </Button>
            </div>
          </CenterCard>
        )}
      </div>
    </div>
  );
}

async function fetchUrlAsPdfBlob(url: string): Promise<Blob> {
  // Inherit the renderer's session (cookies, auth headers handled by the
  // caller's signed URL). Force MIME on the way out so the Electron IPC
  // %PDF magic-byte guard works even if the source server returned a
  // generic content-type.
  const res = await fetch(url, { credentials: "include" });
  if (!res.ok) throw new Error(`Failed to fetch PDF (${res.status})`);
  const buf = await res.arrayBuffer();
  return new Blob([buf], { type: "application/pdf" });
}

function CenterCard({ children }: { children: React.ReactNode }) {
  return (
    <div className="absolute inset-0 flex flex-col items-center justify-center gap-3 p-6 text-center">
      {children}
    </div>
  );
}

export default SafePdfViewer;
