/**
 * CertificateHtmlSurface — the single client-side renderer for v3
 * certificates. Compiles the AST to HTML + CSS Paged Media and paginates
 * it faithfully with paged.js inside an isolated iframe.
 *
 * The SAME compiled HTML is used for the editor live preview and for the
 * filed PDF (via the browser print pipeline), so what a publisher sees is
 * exactly what a tenant files. No pdf-lib, no server rasteriser.
 */
import { forwardRef, useEffect, useImperativeHandle, useMemo, useRef, useState } from "react";
// Vite resolves this to a served, same-origin URL. Loaded *inside* the
// iframe so paged.js paginates the iframe document and its @page rules
// never leak into the host app.
import pagedPolyfillUrl from "pagedjs/dist/paged.polyfill.js?url";
import { compile } from "../lib/engine/compile";
import type { CertificatePayload, CertificateTemplateV3 } from "../lib/engine/types";

export interface CertificateHtmlSurfaceHandle {
  /** Open the browser print dialog for the paginated document (Save as PDF). */
  print: () => void;
  /** The compiled, paginated document HTML currently shown. */
  getHtml: () => string;
}

interface Props {
  template: CertificateTemplateV3;
  payload: CertificatePayload;
  currency?: string;
  className?: string;
  /** Called with binding paths that resolved to empty, for diagnostics UI. */
  onUnresolved?: (paths: string[]) => void;
  onError?: (message: string | null) => void;
}

function buildFrameHtml(compiledHtml: string): string {
  // Inject the paged.js polyfill and a light viewport frame so the
  // paginated pages sit on a neutral backdrop like a real PDF viewer.
  const frameCss = `
    body { background: #525659; margin: 0; }
    .pagedjs_pages { padding: 12px 0; }
    .pagedjs_page { background: #fff; margin: 10px auto; box-shadow: 0 2px 12px rgba(0,0,0,0.4); }
  `;
  return compiledHtml
    .replace("</head>", `<style>${frameCss}</style><script src="${pagedPolyfillUrl}"></script></head>`);
}

export const CertificateHtmlSurface = forwardRef<CertificateHtmlSurfaceHandle, Props>(
  function CertificateHtmlSurface(
    { template, payload, currency, className, onUnresolved, onError },
    ref,
  ) {
    const iframeRef = useRef<HTMLIFrameElement>(null);
    const [srcDoc, setSrcDoc] = useState<string>("");

    const compiled = useMemo(() => {
      try {
        const result = compile(template, payload, { currency });
        onError?.(null);
        onUnresolved?.(result.unresolved);
        return result.html;
      } catch (e: any) {
        onError?.(e?.message ?? String(e));
        return null;
      }
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [template, payload, currency]);

    useEffect(() => {
      if (compiled) setSrcDoc(buildFrameHtml(compiled));
    }, [compiled]);

    useImperativeHandle(ref, () => ({
      print: () => {
        const win = iframeRef.current?.contentWindow;
        if (win) {
          win.focus();
          win.print();
        }
      },
      getHtml: () => compiled ?? "",
    }), [compiled]);

    return (
      <iframe
        ref={iframeRef}
        title="Certificate preview"
        srcDoc={srcDoc}
        className={className ?? "w-full h-[820px] rounded border bg-white"}
        sandbox="allow-same-origin allow-modals allow-scripts"
      />
    );
  },
);
