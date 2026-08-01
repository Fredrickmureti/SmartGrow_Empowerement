/**
 * Architecture invariant: there is exactly ONE transport to the server
 * document renderer.
 *
 * `src/services/printing/pdfUtils.ts::callDocumentRenderer` owns the
 * endpoint URL, the auth shape, the `X-Print-Policy-*` header contract and
 * the error contract. Every render — PDF, ESC/POS, preview, POS test print —
 * comes through it, so preview and print can never drift apart.
 *
 * The one documented exception is `src/services/exports/documentExport.ts`:
 * a CSV/XLSX extract is *data*, not a rendered document. It shares the edge
 * function only for archival (`document_artifacts`), has no paper geometry,
 * no policy headers and no printer, and is explicitly barred from importing
 * the print pipeline.
 */
import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, statSync } from "fs";
import { join } from "path";

const ROOTS = ["src"];

/** Files allowed to name the renderer endpoint in executable code. */
const ALLOWED = new Set<string>([
  "src/services/printing/pdfUtils.ts",
  "src/services/exports/documentExport.ts",
]);

const SKIP_DIRS = new Set(["test", "__tests__", "node_modules"]);

function walk(dir: string): string[] {
  const out: string[] = [];
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return out;
  }
  for (const entry of entries) {
    const p = join(dir, entry);
    if (statSync(p).isDirectory()) {
      if (SKIP_DIRS.has(entry)) continue;
      out.push(...walk(p));
    } else if (/\.tsx?$/.test(entry)) {
      out.push(p);
    }
  }
  return out;
}

/** Strip comments so documentation references don't count as call sites. */
function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
}

describe("document renderer single transport", () => {
  it("only the transport seam calls the generate-document endpoint", () => {
    const offenders: string[] = [];
    for (const root of ROOTS) {
      for (const file of walk(root)) {
        const normalised = file.replace(/\\/g, "/");
        if (ALLOWED.has(normalised)) continue;
        const code = stripComments(readFileSync(file, "utf8"));
        if (/functions\/v1\/generate-document|invoke\(\s*["'`]generate-document/.test(code)) {
          offenders.push(normalised);
        }
      }
    }
    expect(
      offenders,
      "These files call the document renderer directly instead of going " +
        "through pdfUtils. Route them through renderDocumentPreview / " +
        "renderDocumentBytesWithPolicy.\nOffenders:\n" + offenders.join("\n"),
    ).toEqual([]);
  });

  it("the preview dialog renders through PrintService, not raw HTTP", () => {
    const src = readFileSync("src/components/common/PrintPreviewDialog.tsx", "utf8");
    expect(src).toMatch(/renderDocumentPreview/);
    expect(stripComments(src)).not.toMatch(/\bfetch\s*\(/);
  });
});
