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

/** Parses `doc.<n>` → n (or null for header/footer/malformed ids). */
function parseTopLevelIndex(nodeId: string | null | undefined): number | null {
  if (!nodeId) return null;
  const m = /^doc\.(\d+)$/.exec(nodeId);
  return m ? Number(m[1]) : null;
}

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
  /**
   * Direct-manipulation actions on top-level document nodes
   * (`doc.<index>`). The Canvas exposes a hover action strip
   * (move up · move down · duplicate · delete) and native drag-to-
   * reorder; both round-trip through these callbacks so the editor
   * mutates the AST — the Canvas stays purely a render surface.
   */
  onNodeAction?: (nodeId: string, action: "moveUp" | "moveDown" | "duplicate" | "delete") => void;
  onReorder?: (fromIndex: number, toIndex: number) => void;
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
    /* Top-level (doc.N) direct-manipulation affordances. */
    [data-ce-node^="doc."][draggable="true"] { }
    [data-ce-node^="doc."].ce-drag-over { outline: 2px dashed #16a34a; outline-offset: 4px; }
    .ce-actionbar {
      position: absolute; top: -14px; right: 0; z-index: 9999;
      display: none; gap: 2px; padding: 2px;
      background: #2563eb; color: #fff; border-radius: 4px;
      font: 600 10px/1 -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      box-shadow: 0 2px 6px rgba(0,0,0,0.25);
      pointer-events: auto;
    }
    [data-ce-node^="doc."]:hover > .ce-actionbar,
    [data-ce-node^="doc."].ce-selected > .ce-actionbar { display: inline-flex; }
    .ce-actionbar button {
      appearance: none; background: transparent; border: 0; color: inherit;
      padding: 3px 6px; cursor: pointer; border-radius: 2px; font: inherit;
    }
    .ce-actionbar button:hover { background: rgba(255,255,255,0.2); }
    .ce-actionbar .ce-handle { cursor: grab; padding: 3px 5px; opacity: 0.85; }
  `;
  const bridgeJs = `
    (function(){
      var selected = ${JSON.stringify(selectedNodeId)};
      var dragFrom = null;
      function paint(){
        try {
          document.querySelectorAll('[data-ce-node].ce-selected').forEach(function(el){ el.classList.remove('ce-selected'); });
          if (selected) {
            document.querySelectorAll('[data-ce-node="'+selected+'"]').forEach(function(el){ el.classList.add('ce-selected'); });
          }
        } catch(e){}
      }
      function decorateTopLevel(){
        try {
          document.querySelectorAll('[data-ce-node^="doc."]').forEach(function(el){
            if (el.getAttribute('data-ce-decorated') === '1') return;
            el.setAttribute('data-ce-decorated', '1');
            el.setAttribute('draggable', 'true');
            var bar = document.createElement('div');
            bar.className = 'ce-actionbar';
            bar.setAttribute('contenteditable', 'false');
            bar.innerHTML =
              '<span class="ce-handle" title="Drag to reorder">⋮⋮</span>' +
              '<button data-act="moveUp" title="Move up">▲</button>' +
              '<button data-act="moveDown" title="Move down">▼</button>' +
              '<button data-act="duplicate" title="Duplicate">⧉</button>' +
              '<button data-act="delete" title="Delete">✕</button>';
            // Actions bubble to the shared listener below.
            el.appendChild(bar);
          });
        } catch(e){}
      }
      // Native drag reorder on top-level nodes.
      document.addEventListener('dragstart', function(ev){
        var el = ev.target && ev.target.closest ? ev.target.closest('[data-ce-node^="doc."]') : null;
        if (!el) return;
        dragFrom = el.getAttribute('data-ce-node');
        try { ev.dataTransfer.effectAllowed = 'move'; ev.dataTransfer.setData('text/plain', dragFrom); } catch(e){}
      });
      document.addEventListener('dragover', function(ev){
        var el = ev.target && ev.target.closest ? ev.target.closest('[data-ce-node^="doc."]') : null;
        if (!el || !dragFrom || el.getAttribute('data-ce-node') === dragFrom) return;
        ev.preventDefault();
        try { ev.dataTransfer.dropEffect = 'move'; } catch(e){}
        document.querySelectorAll('[data-ce-node^="doc."].ce-drag-over').forEach(function(n){ n.classList.remove('ce-drag-over'); });
        el.classList.add('ce-drag-over');
      });
      document.addEventListener('dragleave', function(ev){
        var el = ev.target && ev.target.closest ? ev.target.closest('[data-ce-node^="doc."]') : null;
        if (el) el.classList.remove('ce-drag-over');
      });
      document.addEventListener('drop', function(ev){
        var el = ev.target && ev.target.closest ? ev.target.closest('[data-ce-node^="doc."]') : null;
        if (!el || !dragFrom) return;
        ev.preventDefault();
        var to = el.getAttribute('data-ce-node');
        document.querySelectorAll('[data-ce-node^="doc."].ce-drag-over').forEach(function(n){ n.classList.remove('ce-drag-over'); });
        try { parent.postMessage({ source: 'ce-surface', kind: 'reorder', from: dragFrom, to: to }, '*'); } catch(e){}
        dragFrom = null;
      });
      document.addEventListener('dragend', function(){ dragFrom = null; });
      document.addEventListener('click', function(ev){
        // Action-bar buttons take precedence over the generic select handler.
        var btn = ev.target && ev.target.closest ? ev.target.closest('.ce-actionbar button[data-act]') : null;
        if (btn) {
          ev.preventDefault(); ev.stopPropagation();
          var host = btn.closest('[data-ce-node]');
          var id = host && host.getAttribute('data-ce-node');
          var act = btn.getAttribute('data-act');
          if (id && act) { try { parent.postMessage({ source: 'ce-surface', kind: 'action', nodeId: id, action: act }, '*'); } catch(e){} }
          return;
        }
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
      window.addEventListener('load', function(){ setTimeout(function(){ decorateTopLevel(); paint(); }, 400); });
      document.addEventListener('pagedjs:pagerendered', function(){ setTimeout(function(){ decorateTopLevel(); paint(); }, 50); });
    })();
  `;
  return compiledHtml.replace(
    "</head>",
    `<style>${frameCss}</style><script src="${pagedPolyfillUrl}"></script><script>${bridgeJs}</script></head>`,
  );
}

export const CertificateHtmlSurface = forwardRef<CertificateHtmlSurfaceHandle, Props>(
  function CertificateHtmlSurface(
    { template, payload, currency, className, onUnresolved, onError, onSelectNode, selectedNodeId, onNodeAction, onReorder },
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
        if (!d || d.source !== "ce-surface") return;
        if (d.kind === "select") {
          onSelectNode?.(d.nodeId as string, d.nodeType as string);
        } else if (d.kind === "action") {
          onNodeAction?.(d.nodeId as string, d.action as any);
        } else if (d.kind === "reorder") {
          const from = parseTopLevelIndex(d.from as string);
          const to = parseTopLevelIndex(d.to as string);
          if (from != null && to != null && from !== to) onReorder?.(from, to);
        }
      };
      window.addEventListener("message", handler);
      return () => window.removeEventListener("message", handler);
    }, [onSelectNode, onNodeAction, onReorder]);

    useImperativeHandle(ref, () => ({
      print: () => {
        const win = iframeRef.current?.contentWindow;
        if (win) {
          win.focus();
          win.print();
        }
      },
      getHtml: () => compiled.html ?? "",
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
