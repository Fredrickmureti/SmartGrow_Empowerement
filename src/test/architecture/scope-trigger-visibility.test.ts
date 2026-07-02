/**
 * Architecture guard — every component that exposes a "switch scope"
 * affordance MUST gate its trigger with `useCanSwitchScope()` so the
 * affordance disappears on single-target tenants.
 *
 * Two detection rules:
 *   1. Mounts the global sheet: `<ContextSwitcherSheet ... />`
 *   2. Hand-rolled trigger: any JSX whose visible text matches one of the
 *      scope-switch phrases (`Change scope`, `Switch branch`, `Switch
 *      company`, `Switch workspace`), OR a DropdownMenu/Select fed by
 *      `useBranches()` / `useBusinesses()` results.
 *
 * Reference implementations: `ScopeBadge`, `SidebarContextSwitcher`,
 * `BranchScopeToggle`, `DashboardScopeSwitcher`.
 *
 * Allow-list: add a `// SCOPE-TRIGGER-EXEMPT: <reason>` comment anywhere
 * in the file to skip the check.
 */
import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, sep, posix } from "node:path";

const SCAN_DIRS = ["src/components", "src/pages", "src/apps"];
const EXEMPT_MARKER = "SCOPE-TRIGGER-EXEMPT:";

const MOUNTS_SHEET = /<ContextSwitcherSheet[\s/>]/;
const USES_HOOK = /useCanSwitchScope\s*\(/;

// Rule 2a — visible trigger label.
const TRIGGER_LABEL =
  /(?:Change\s+scope|Switch\s+branch|Switch\s+company|Switch\s+workspace)/i;

// Rule 2b — DropdownMenu / Select whose items iterate over branches/businesses.
// Heuristic: file imports useBranches or useBusinesses AND renders a
// DropdownMenuItem or SelectItem inside a .map( over a `branches` /
// `businesses` identifier.
const IMPORTS_SCOPE_LIST = /useBranches\b|useBusinesses\b/;
const RENDERS_SCOPE_DROPDOWN =
  /(?:branches|businesses)\s*\.\s*(?:map|filter)\s*\([^)]*\)\s*=>\s*[\s\S]{0,400}?<(?:DropdownMenuItem|SelectItem|CommandItem)\b/;

// Reference / read-only files: render context info but never offer a switch.
// These intentionally consume useBranches without exposing a trigger.
const ALLOWLIST = new Set<string>([
  "src/components/organization/ContextSwitcherSheet.tsx",
]);

function walk(dir: string): string[] {
  const out: string[] = [];
  let entries: string[] = [];
  try {
    entries = readdirSync(dir);
  } catch {
    return out;
  }
  for (const name of entries) {
    if (name === "node_modules" || name === "dist") continue;
    const p = join(dir, name);
    const s = statSync(p);
    if (s.isDirectory()) out.push(...walk(p));
    else if (/\.tsx$/.test(name) && !/\.test\.tsx?$/.test(name)) out.push(p);
  }
  return out;
}

const toPosix = (p: string) => p.split(sep).join(posix.sep);

interface Offender {
  file: string;
  reason: string;
}

const offenders: Offender[] = [];
for (const file of SCAN_DIRS.flatMap(walk)) {
  const rel = toPosix(file);
  if (ALLOWLIST.has(rel)) continue;
  const src = readFileSync(file, "utf8");
  if (src.includes(EXEMPT_MARKER)) continue;
  if (USES_HOOK.test(src)) continue;

  if (MOUNTS_SHEET.test(src)) {
    offenders.push({ file: rel, reason: "mounts <ContextSwitcherSheet />" });
    continue;
  }
  if (TRIGGER_LABEL.test(src)) {
    offenders.push({ file: rel, reason: `renders scope-switch label (${TRIGGER_LABEL.source})` });
    continue;
  }
  if (IMPORTS_SCOPE_LIST.test(src) && RENDERS_SCOPE_DROPDOWN.test(src)) {
    offenders.push({
      file: rel,
      reason: "iterates branches/businesses into a DropdownMenu/Select trigger",
    });
  }
}

describe("architecture: scope-switch triggers are gated by useCanSwitchScope", () => {
  it("every scope-switch trigger consults useCanSwitchScope (or is exempt)", () => {
    if (offenders.length > 0) {
      throw new Error(
        `[arch-guard] ${offenders.length} unguarded scope-switch trigger(s):\n` +
          offenders.map((o) => `  ${o.file} — ${o.reason}`).join("\n") +
          `\n\nGate the trigger with useCanSwitchScope(), or add a ` +
          `// SCOPE-TRIGGER-EXEMPT: <reason> comment if intentional.`,
      );
    }
    expect(offenders.length).toBe(0);
  });
});
