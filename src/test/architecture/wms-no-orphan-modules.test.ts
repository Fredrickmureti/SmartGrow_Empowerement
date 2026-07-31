/**
 * Phase 5.3 — no orphan warehouse modules.
 *
 * A module under `src/features/warehouse/**` that nothing outside the
 * test tree imports is dead weight that still looks like architecture:
 * reviewers assume the flow it describes is live, guards "pass" against
 * code no operator can reach, and the real screen quietly does something
 * else. Either a real call site exists, or the module is deleted.
 *
 * Deliberately no allow-list. If this fails, wire the module into the
 * workflow it was written for or remove it.
 */
import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";

const ROOT = path.resolve(__dirname, "../../..");
const SRC = path.join(ROOT, "src");
const WATCHED = "src/features/warehouse/";

/** Every ts/tsx file under src/, as posix-ish project-relative paths. */
function allSourceFiles(): string[] {
  const out: string[] = [];
  (function walk(dir: string) {
    for (const entry of readdirSync(dir)) {
      if (entry === "node_modules") continue;
      const abs = path.join(dir, entry);
      if (statSync(abs).isDirectory()) walk(abs);
      else if (/\.tsx?$/.test(entry)) out.push(path.relative(ROOT, abs).split(path.sep).join("/"));
    }
  })(SRC);
  return out;
}

const FILES = allSourceFiles();
const FILE_SET = new Set(FILES);

const isTestFile = (p: string) =>
  p.startsWith("src/test/") || /\.(test|spec)\.tsx?$/.test(p);

/** Resolve an `@/` or relative specifier to a file in the project. */
function resolveSpecifier(spec: string, importer: string): string | null {
  let base: string;
  if (spec.startsWith("@/")) base = "src/" + spec.slice(2);
  else if (spec.startsWith(".")) {
    base = path
      .normalize(path.join(path.dirname(importer), spec))
      .split(path.sep)
      .join("/");
  } else return null;

  const candidates = [
    base,
    `${base}.ts`,
    `${base}.tsx`,
    `${base}/index.ts`,
    `${base}/index.tsx`,
  ];
  return candidates.find((c) => FILE_SET.has(c)) ?? null;
}

/** target file -> importers (static imports, re-exports and dynamic imports). */
function buildImportGraph(): Map<string, Set<string>> {
  const graph = new Map<string, Set<string>>();
  const re = /(?:from|import)\s+["']([^"']+)["']|import\(\s*["']([^"']+)["']\s*\)/g;
  for (const file of FILES) {
    const src = readFileSync(path.join(ROOT, file), "utf8");
    let m: RegExpExecArray | null;
    while ((m = re.exec(src)) !== null) {
      const target = resolveSpecifier(m[1] ?? m[2], file);
      if (!target || target === file) continue;
      if (!graph.has(target)) graph.set(target, new Set());
      graph.get(target)!.add(file);
    }
  }
  return graph;
}

const GRAPH = buildImportGraph();

describe("WMS feature modules are reachable from the running app", () => {
  it("finds warehouse feature modules to check", () => {
    expect(FILES.filter((f) => f.startsWith(WATCHED)).length).toBeGreaterThan(10);
  });

  it("no module under src/features/warehouse is imported only by tests", () => {
    const orphans = FILES.filter((f) => f.startsWith(WATCHED) && !isTestFile(f)).filter(
      (f) => {
        const importers = [...(GRAPH.get(f) ?? [])].filter((p) => !isTestFile(p));
        return importers.length === 0;
      },
    );
    expect(
      orphans,
      "Orphaned WMS modules — wire them into a real screen or delete them:\n" +
        orphans.join("\n"),
    ).toEqual([]);
  });

  it("the FSM transition wrappers have a production call site", () => {
    // Regression pin for the specific orphan this phase closed: the typed
    // wms_transition_* hooks were unreachable, so no screen could cancel a
    // wave, manifest or count session.
    const importers = [
      ...(GRAPH.get("src/features/warehouse/aggregates/useAggregateTransitions.ts") ?? []),
    ].filter((p) => !isTestFile(p));
    expect(importers.length).toBeGreaterThan(0);
    const cancelButton = "src/features/warehouse/aggregates/CancelAggregateButton.tsx";
    expect(FILE_SET.has(cancelButton)).toBe(true);
    const buttonUsers = [...(GRAPH.get(cancelButton) ?? [])].filter((p) => !isTestFile(p));
    expect(
      buttonUsers.some((p) => p.startsWith("src/pages/warehouse/")),
      "CancelAggregateButton must be mounted on at least one warehouse screen",
    ).toBe(true);
  });
});
