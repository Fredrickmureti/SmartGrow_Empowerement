/**
 * printCertificateHtml — client-side materialisation of a v3 certificate.
 *
 * The audited artifact stored on a certificate is the compiled HTML
 * (CSS Paged Media) produced by the certificate engine — byte-identical
 * to the publisher editor preview. This helper paginates that HTML with
 * paged.js inside an isolated, on-screen overlay iframe and lets the user
 * save it as a vector PDF via the browser print pipeline.
 *
 * There is deliberately no pdf-lib / server rasteriser: "what you preview
 * is what you file" holds because the exact same HTML drives preview,
 * this overlay, and the printed PDF.
 */
// Same-origin URL served from /public/vendor/ (see CertificateHtmlSurface).
// Loaded *inside* the overlay iframe so paged.js paginates the iframe
// document and its @page rules never leak into the host app.
const pagedPolyfillUrl = "/vendor/paged.polyfill.js";

function frameHtml(compiledHtml: string): string {
  const frameCss = `
    body { background: #525659; margin: 0; }
    .pagedjs_pages { padding: 12px 0; }
    .pagedjs_page { background: #fff; margin: 10px auto; box-shadow: 0 2px 12px rgba(0,0,0,0.4); }
    @media print {
      body { background: #fff; }
      .pagedjs_page { margin: 0 auto; box-shadow: none; }
    }
  `;
  if (compiledHtml.includes("</head>")) {
    return compiledHtml.replace(
      "</head>",
      `<style>${frameCss}</style><script src="${pagedPolyfillUrl}"></script></head>`,
    );
  }
  // Defensive fallback for bodies that are not a full document.
  return `<!doctype html><html><head><meta charset="utf-8"><style>${frameCss}</style><script src="${pagedPolyfillUrl}"></script></head><body>${compiledHtml}</body></html>`;
}

/**
 * Open an on-screen paginated preview of `compiledHtml` with a toolbar to
 * print / save as PDF. Returns a disposer that closes the overlay.
 */
export function printCertificateHtml(
  compiledHtml: string,
  opts: { title?: string; autoPrint?: boolean } = {},
): () => void {
  const overlay = document.createElement("div");
  overlay.setAttribute("role", "dialog");
  overlay.setAttribute("aria-label", opts.title ?? "Certificate preview");
  Object.assign(overlay.style, {
    position: "fixed",
    inset: "0",
    zIndex: "2147483000",
    display: "flex",
    flexDirection: "column",
    background: "rgba(15,23,42,0.75)",
  } as CSSStyleDeclaration);

  const toolbar = document.createElement("div");
  Object.assign(toolbar.style, {
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
    gap: "12px",
    padding: "10px 16px",
    background: "#1e293b",
    color: "#f8fafc",
    font: "500 14px system-ui, sans-serif",
  } as CSSStyleDeclaration);

  const title = document.createElement("span");
  title.textContent = opts.title ?? "Certificate";

  const actions = document.createElement("div");
  actions.style.display = "flex";
  actions.style.gap = "8px";

  const printBtn = document.createElement("button");
  printBtn.textContent = "Print / Save as PDF";
  Object.assign(printBtn.style, {
    padding: "6px 14px",
    borderRadius: "6px",
    border: "0",
    cursor: "pointer",
    background: "#2563eb",
    color: "#fff",
    font: "600 13px system-ui, sans-serif",
  } as CSSStyleDeclaration);

  const closeBtn = document.createElement("button");
  closeBtn.textContent = "Close";
  Object.assign(closeBtn.style, {
    padding: "6px 14px",
    borderRadius: "6px",
    border: "1px solid #475569",
    cursor: "pointer",
    background: "transparent",
    color: "#e2e8f0",
    font: "600 13px system-ui, sans-serif",
  } as CSSStyleDeclaration);

  actions.append(printBtn, closeBtn);
  toolbar.append(title, actions);

  const iframe = document.createElement("iframe");
  iframe.title = opts.title ?? "Certificate preview";
  iframe.setAttribute("sandbox", "allow-same-origin allow-modals allow-scripts");
  Object.assign(iframe.style, {
    flex: "1",
    width: "100%",
    border: "0",
    background: "#525659",
  } as CSSStyleDeclaration);
  iframe.srcdoc = frameHtml(compiledHtml);

  overlay.append(toolbar, iframe);

  const dispose = () => {
    window.removeEventListener("keydown", onKey);
    overlay.remove();
  };
  const onKey = (e: KeyboardEvent) => {
    if (e.key === "Escape") dispose();
  };

  const doPrint = () => {
    const win = iframe.contentWindow;
    if (win) {
      win.focus();
      win.print();
    }
  };

  printBtn.addEventListener("click", doPrint);
  closeBtn.addEventListener("click", dispose);
  overlay.addEventListener("click", (e) => {
    if (e.target === overlay) dispose();
  });
  window.addEventListener("keydown", onKey);

  document.body.appendChild(overlay);

  if (opts.autoPrint) {
    // Give paged.js time to paginate before invoking print.
    iframe.addEventListener("load", () => window.setTimeout(doPrint, 1200));
  }

  return dispose;
}
