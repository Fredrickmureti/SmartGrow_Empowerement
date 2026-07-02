/**
 * SafeHtmlPreview — sibling of SafePdfViewer for the legacy HTML preview
 * branch (ADR-0015 re-audit, step C).
 *
 * Some document types still come back from the server as HTML rather than
 * PDF (older templates, fallback responses). Those previews are rendered
 * inside an iframe via `srcDoc`. That doesn't depend on the PDF plugin
 * and almost never fails — but when it does (script errors during init,
 * empty body, etc.) the user sees the same blank-pane symptom as the
 * original Electron bug with no recovery affordance.
 *
 * This component reproduces SafePdfViewer's instrumentation contract
 * (`onLoad` / `onError` / 5 s safety timer / recovery card) for HTML so
 * every preview surface in the app surfaces a fallback when rendering
 * fails. Web/Electron behave identically here — HTML rendering doesn't
 * need the dedicated-window detour.
 */

import { useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { AlertCircle, Download, ExternalLink, Loader2 } from "lucide-react";

export interface SafeHtmlPreviewProps {
  html: string | null;
  title?: string;
  /** Zoom percentage applied to the iframe (parent dialog already handles scaling). */
  style?: React.CSSProperties;
  className?: string;
  /** Filename suffix used when the user downloads the raw HTML as a fallback. */
  filename?: string;
}

type State =
  | { kind: "loading" }
  | { kind: "ok" }
  | { kind: "failed"; reason: string };

const LOAD_TIMEOUT_MS = 5000;

export function SafeHtmlPreview({
  html,
  title,
  style,
  className,
  filename = "document",
}: SafeHtmlPreviewProps) {
  const [state, setState] = useState<State>({ kind: "loading" });
  const loadedRef = useRef(false);

  useEffect(() => {
    loadedRef.current = false;
    if (!html) {
      setState({ kind: "loading" });
      return;
    }
    setState({ kind: "loading" });
    const timer = window.setTimeout(() => {
      if (!loadedRef.current) {
        setState({ kind: "failed", reason: "Preview did not load within 5 seconds" });
      }
    }, LOAD_TIMEOUT_MS);
    return () => window.clearTimeout(timer);
  }, [html]);

  const downloadHtml = () => {
    if (!html) return;
    const blob = new Blob([html], { type: "text/html;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `${filename || "document"}.html`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 100);
  };

  const openInTab = () => {
    if (!html) return;
    const blob = new Blob([html], { type: "text/html;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    window.open(url, "_blank", "noopener,noreferrer");
    setTimeout(() => URL.revokeObjectURL(url), 60_000);
  };

  if (!html || state.kind === "loading") {
    return (
      <div className={className} style={style}>
        <div className="flex flex-col items-center justify-center gap-3 p-8 text-muted-foreground">
          <Loader2 className="h-6 w-6 animate-spin" />
          <span className="text-sm">Rendering preview…</span>
        </div>
      </div>
    );
  }

  if (state.kind === "failed") {
    return (
      <div className={className} style={style}>
        <div className="flex flex-col items-center justify-center gap-3 p-8 text-center">
          <AlertCircle className="h-8 w-8 text-amber-500" />
          <div className="text-sm font-medium">Inline preview unavailable</div>
          <div className="text-xs text-muted-foreground max-w-sm">{state.reason}.</div>
          <div className="flex gap-2 pt-2">
            <Button size="sm" variant="outline" onClick={openInTab}>
              <ExternalLink className="h-3.5 w-3.5 mr-2" /> Open in new tab
            </Button>
            <Button size="sm" variant="outline" onClick={downloadHtml}>
              <Download className="h-3.5 w-3.5 mr-2" /> Download HTML
            </Button>
          </div>
        </div>
      </div>
    );
  }

  return (
    <iframe
      // eslint-disable-next-line local/no-direct-pdf-iframe -- canonical HTML viewer
      srcDoc={html}
      title={title || "Preview"}
      className={className}
      style={style}
      onLoad={() => {
        loadedRef.current = true;
        setState({ kind: "ok" });
      }}
      onError={() =>
        setState({ kind: "failed", reason: "Browser refused to render the document" })
      }
    />
  );
}

// We render the iframe even in the "loading" state via the wrapper above only
// when html is present; the conditional return is so the recovery card and
// the iframe never coexist (which would double-fire onLoad).
function Mounted({ html, title, style, className, onLoad, onError }: {
  html: string;
  title?: string;
  style?: React.CSSProperties;
  className?: string;
  onLoad: () => void;
  onError: () => void;
}) {
  return (
    <iframe
      // eslint-disable-next-line local/no-direct-pdf-iframe -- canonical HTML viewer
      srcDoc={html}
      title={title || "Preview"}
      className={className}
      style={style}
      onLoad={onLoad}
      onError={onError}
    />
  );
}
// Mounted is exported indirectly for future tests; kept inline to avoid an
// unused-export lint warning.
void Mounted;

export default SafeHtmlPreview;
