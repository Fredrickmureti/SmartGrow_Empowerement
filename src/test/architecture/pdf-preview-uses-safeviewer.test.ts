/**
 * Architecture guard — ensure every PDF/HTML preview surface in the app
 * funnels through SafePdfViewer / SafeHtmlPreview (ADR-0015).
 *
 * Scans `src/components/**` for raw `<iframe …>` JSX whose source
 * resembles a PDF/blob/preview URL. The only files allowed to mount one
 * are the canonical viewers themselves.
 *
 * Complements the ESLint rule `local/no-direct-pdf-iframe` — the lint rule
 * catches new code; this test catches drift even when lint is bypassed.
 */
import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

const ROOT = join(process.cwd(), "src", "components");
const ALLOWLIST = new Set<string>([
  join(ROOT, "common", "SafePdfViewer.tsx"),
  join(ROOT, "common", "SafeHtmlPreview.tsx"),
]);

function walk(dir: string, acc: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    const s = statSync(full);
    if (s.isDirectory()) walk(full, acc);
    else if (/\.(tsx|jsx)$/.test(name)) acc.push(full);
  }
  return acc;
}

const IFRAME_RE = /<iframe\b[^>]*(?:src|srcDoc)\s*=\s*\{?[^}>]*\}?/gi;
const SUSPECT_RE = /(blob|pdf|preview|signedUrl|signed_url|previewUrl|previewURL|file|document|html|srcDoc)/i;

describe("PDF/HTML preview architecture (ADR-0015)", () => {
  it("only SafePdfViewer and SafeHtmlPreview mount raw <iframe> preview sources", () => {
    const offenders: { file: string; snippet: string }[] = [];
    for (const file of walk(ROOT)) {
      if (ALLOWLIST.has(file)) continue;
      const src = readFileSync(file, "utf8");
      const matches = src.match(IFRAME_RE);
      if (!matches) continue;
      for (const m of matches) {
        // Allow non-preview iframes (e.g. YouTube embeds, OAuth callbacks)
        // by requiring the suggestive name in the same opening tag.
        if (SUSPECT_RE.test(m)) {
          offenders.push({ file: file.replace(process.cwd() + "/", ""), snippet: m.slice(0, 160) });
        }
      }
    }
    if (offenders.length > 0) {
      const msg = offenders
        .map((o) => `  - ${o.file}\n      ${o.snippet}`)
        .join("\n");
      throw new Error(
        `Found ${offenders.length} raw <iframe> preview source(s) outside SafePdfViewer/SafeHtmlPreview:\n${msg}`,
      );
    }
    expect(offenders).toEqual([]);
  });
});
