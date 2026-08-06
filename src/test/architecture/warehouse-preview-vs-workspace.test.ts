/**
 * Architecture guard for ADR 0122 — warehouse previews stay previews.
 *
 * A side pane that grows form fields, tabs or dialogs has become a second
 * application squeezed into 420px. Depth belongs on the entity workspace
 * route, which is why every preview must expose a door to one.
 */
import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, resolve, relative } from "node:path";

const WAREHOUSE_FEATURES = resolve(__dirname, "../../../src/features/warehouse");
const ROOT = resolve(__dirname, "../../..");

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const full = join(dir, entry);
    return statSync(full).isDirectory() ? walk(full) : [full];
  });
}

const previewFiles = walk(WAREHOUSE_FEATURES).filter((f) =>
  /Preview\.tsx$/.test(f) && !/entity\/EntityPreview\.tsx$/.test(f),
);

/** Editing/depth surfaces that must live on a workspace route instead. */
const FORBIDDEN: { pattern: RegExp; why: string }[] = [
  { pattern: /from\s+["']@\/components\/ui\/input["']/, why: "text inputs" },
  { pattern: /from\s+["']@\/components\/ui\/textarea["']/, why: "textareas" },
  { pattern: /from\s+["']@\/components\/ui\/tabs["']/, why: "tab systems" },
  { pattern: /from\s+["']@\/components\/ui\/dialog["']/, why: "dialogs" },
  { pattern: /from\s+["']@\/components\/ui\/form["']/, why: "form scaffolding" },
];

describe("ADR 0122: warehouse previews are read-only peeks", () => {
  it("finds preview components to inspect (smoke)", () => {
    expect(previewFiles.length).toBeGreaterThan(0);
  });

  it("no preview renders editing or depth surfaces", () => {
    const offenders: string[] = [];
    for (const file of previewFiles) {
      const text = readFileSync(file, "utf-8");
      for (const { pattern, why } of FORBIDDEN) {
        if (pattern.test(text)) {
          offenders.push(`${relative(ROOT, file)} → ${why}`);
        }
      }
    }
    expect(
      offenders,
      "Previews must stay read-only peeks (ADR 0122). Move these to the " +
        "entity's workspace route via EntityWorkspaceShell:\n" + offenders.join("\n"),
    ).toEqual([]);
  });

  it("every preview offers a door to its workspace", () => {
    const offenders = previewFiles.filter(
      (f) => !/workspaceHref/.test(readFileSync(f, "utf-8")),
    );
    expect(
      offenders.map((f) => relative(ROOT, f)),
      "Each preview must pass `workspaceHref` so depth is one click away.",
    ).toEqual([]);
  });

  it("the deleted LocationInspector does not come back", () => {
    const files = walk(WAREHOUSE_FEATURES).map((f) => relative(ROOT, f));
    expect(files.filter((f) => /LocationInspector/.test(f))).toEqual([]);
  });
});
