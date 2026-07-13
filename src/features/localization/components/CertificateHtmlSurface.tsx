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
// Same-origin URL for the paged.js polyfill. Served from /public/vendor/ so
// it loads *inside* the iframe and its @page rules never leak into the host
// app. Copied at repo-setup time (see public/vendor/paged.polyfill.js) — the
// upstream `pagedjs` package does not expose this file through its exports
// map, so bundling it via `?url` is not portable.
const pagedPolyfillUrl = "/vendor/paged.polyfill.js";
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
  /**
   * WYSIWYG click-to-select bridge. Fires when a publisher clicks any
   * `[data-ce-node]` element in the rendered document. The `nodeId` is
   * the stable path-based id emitted by compile() (`doc.<index>`,
   * `hdr.<index>`, `ftr.<index>`). Selected nodeId is highlighted with
   * a ring overlay inside the iframe.
   */
  onSelectNode?: (nodeId: string, type: string) => void;
  /** Currently-selected nodeId (drives the highlight ring). */
  selectedNodeId?: string | null;
}

function buildFrameHtml(compiledHtml: string, selectedNodeId: string | null): string {
  // Inject the paged.js polyfill, a light viewport frame, and the
  // click-to-select bridge script. The bridge relays clicks on any
  // `[data-ce-node]` up to the parent editor via postMessage, and
  // paints a ring around the currently-selected node so the publisher
  // sees exactly what they're editing.
  const frameCss = `
    body { background: #525659; margin: 0; }
    .pagedjs_pages { padding: 12px 0; }
    .pagedjs_page { background: #fff; margin: 10px auto; box-shadow: 0 2px 12px rgba(0,0,0,0.4); }
    [data-ce-node] { cursor: pointer; position: relative; }
    [data-ce-node]:hover { outline: 1px dashed #2563eb; outline-offset: 2px; }
    [data-ce-node].ce-selected { outline: 2px solid #2563eb; outline-offset: 2px; box-shadow: 0 0 0 4px rgba(37,99,235,0.15); }
  `;
  const bridgeJs = `
    (function(){
      var selected = ${JSON.stringify(selectedNodeId)};
      function paint(){
        try {
          document.querySelectorAll('[data-ce-node].ce-selected').forEach(function(el){ el.classList.remove('ce-selected'); });
          if (selected) {
            document.querySelectorAll('[data-ce-node="'+selected+'"]').forEach(function(el){ el.classList.add('ce-selected'); });
          }
        } catch(e){}
      }
      document.addEventListener('click', function(ev){
        var el = ev.target && ev.target.closest ? ev.target.closest('[data-ce-node]') : null;
        if (!el) return;
        ev.preventDefault();
        ev.stopPropagation();
        var id = el.getAttribute('data-ce-node');
        var type = el.getAttribute('data-ce-type');
        selected = id;
        paint();
        try { parent.postMessage({ source: 'ce-surface', kind: 'select', nodeId: id, nodeType: type }, '*'); } catch(e){}
      }, true);
      window.addEventListener('message', function(ev){
        var d = ev.data;
        if (!d || d.target !== 'ce-surface') return;
        if (d.kind === 'select') { selected = d.nodeId || null; paint(); }
      });
      // Paint after paged.js has laid out (fires 'pagedjs' event) or on load.
      window.addEventListener('load', function(){ setTimeout(paint, 400); });
      document.addEventListener('pagedjs:pagerendered', function(){ setTimeout(paint, 50); });
    })();
  `;
  return compiledHtml.replace(
    "</head>",
    `<style>${frameCss}</style><script src="${pagedPolyfillUrl}"></script><script>${bridgeJs}</script></head>`,
  );
}

export const CertificateHtmlSurface = forwardRef<CertificateHtmlSurfaceHandle, Props>(
  function CertificateHtmlSurface(
    { template, payload, currency, className, onUnresolved, onError, onSelectNode, selectedNodeId },
    ref,
  ) {
    const iframeRef = useRef<HTMLIFrameElement>(null);
    const [srcDoc, setSrcDoc] = useState<string>("");

    // Serialize inputs to a stable key so parent re-renders that create
    // new object literals for `template`/`payload` don't retrigger compile
    // (which would loop when compile fires setState via onError/onUnresolved).
    const inputsKey = useMemo(
      () => JSON.stringify({ template, payload, currency }),
      [template, payload, currency],
    );

    const compiled = useMemo<{ html: string | null; unresolved: string[]; error: string | null }>(() => {
      try {
        const result = compile(template, payload, { currency });
        return { html: result.html, unresolved: result.unresolved, error: null };
      } catch (e: any) {
        return { html: null, unresolved: [], error: e?.message ?? String(e) };
      }
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [inputsKey]);

    // Report compile diagnostics in an effect — never during render — so
    // parent setState cannot re-enter the render pass and cause React's
    // "Maximum update depth exceeded" loop.
    useEffect(() => {
      onError?.(compiled.error);
      onUnresolved?.(compiled.unresolved);
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [compiled]);

    useEffect(() => {
      if (compiled.html) setSrcDoc(buildFrameHtml(compiled.html, selectedNodeId ?? null));
      // Only re-generate srcDoc when the compiled body changes; selection
      // updates are relayed via postMessage to avoid re-paginating.
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [compiled.html]);

    // Relay selection changes into the iframe without reloading it.
    useEffect(() => {
      const win = iframeRef.current?.contentWindow;
      if (!win) return;
      try { win.postMessage({ target: "ce-surface", kind: "select", nodeId: selectedNodeId ?? null }, "*"); } catch { /* noop */ }
    }, [selectedNodeId]);

    // Listen for click-select messages from the iframe and forward.
    useEffect(() => {
      const handler = (ev: MessageEvent) => {
        const d = ev.data;
        if (!d || d.source !== "ce-surface" || d.kind !== "select") return;
        onSelectNode?.(d.nodeId as string, d.nodeType as string);
      };
      window.addEventListener("message", handler);
      return () => window.removeEventListener("message", handler);
    }, [onSelectNode]);

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
