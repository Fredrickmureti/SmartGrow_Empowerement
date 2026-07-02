/**
 * Phase B0 — Routing parity guard.
 *
 * Every entry in `REPORT_REGISTRY` MUST be reachable via a real route in the
 * react-router-dom tree (`src/App.tsx` + per-app nested route files).
 *
 * Background
 * ----------
 * The app has TWO routing surfaces:
 *   - `src/App.tsx` (react-router-dom — the real one used at runtime)
 *   - `src/routes/*` (TanStack Start shell, mostly legacy redirects)
 *
 * Before this guard existed it was easy to add a new report to the registry,
 * wire its page component, and forget to register the actual URL — the
 * command palette would route to a 404. This test catches that drift at
 * build time.
 *
 * Match rule (static, deliberately permissive to avoid false-fails):
 *   For a registry path like `/finance/reports/cash-flow`, we accept ANY
 *   `path="..."` literal in App.tsx or the per-app route files whose
 *   segments concatenate (across nested <Route> declarations) to the same
 *   path. The cheap heuristic used here: the final segment of the registry
 *   path must appear as a `path="<segment>"` literal somewhere in one of
 *   the route source files. False negatives would only occur if two reports
 *   share a last segment — in which case the test still passes because at
 *   least one valid mount exists. False positives are not possible: if the
 *   literal is missing, react-router cannot mount it.
 */
import { describe, it, expect } from "vitest";
import { readFileSync, existsSync, readdirSync, statSync } from "node:fs";
import { resolve, join } from "node:path";
import { REPORT_REGISTRY } from "@/services/reports/ReportRegistry";

const REPO_ROOT = resolve(__dirname, "../../..");

const ROUTE_FILES = [
  "src/App.tsx",
  ...collectAppRouteFiles("src/apps"),
  ...collectTanStackRouteFiles("src/routes"),
];

function collectAppRouteFiles(rel: string): string[] {
  const out: string[] = [];
  const abs = join(REPO_ROOT, rel);
  if (!existsSync(abs)) return out;
  for (const entry of readdirSync(abs)) {
    const child = join(abs, entry);
    if (statSync(child).isDirectory()) {
      const routes = join(child, "routes.tsx");
      if (existsSync(routes)) out.push(`${rel}/${entry}/routes.tsx`);
      const sub = join(child, "sub");
      if (existsSync(sub) && statSync(sub).isDirectory()) {
        for (const subEntry of readdirSync(sub)) {
          if (subEntry.endsWith("Routes.tsx")) {
            out.push(`${rel}/${entry}/sub/${subEntry}`);
          }
        }
      }
    }
  }
  return out;
}

/**
 * Walk the TanStack Start route tree (`src/routes/**`). Mostly legacy
 * redirects today, but closes the dual-router hazard called out in the
 * Phase A risk register: a registry path satisfied only by a TanStack
 * route would otherwise look unrouted to this guard.
 */
function collectTanStackRouteFiles(rel: string): string[] {
  const out: string[] = [];
  const abs = join(REPO_ROOT, rel);
  if (!existsSync(abs)) return out;
  const walk = (dir: string, prefix: string) => {
    for (const entry of readdirSync(dir)) {
      const child = join(dir, entry);
      const childRel = `${prefix}/${entry}`;
      if (statSync(child).isDirectory()) {
        walk(child, childRel);
      } else if (entry.endsWith(".tsx") || entry.endsWith(".ts")) {
        out.push(childRel);
      }
    }
  };
  walk(abs, rel);
  return out;
}

const haystacks = ROUTE_FILES
  .map((f) => ({ f, src: existsSync(join(REPO_ROOT, f)) ? readFileSync(join(REPO_ROOT, f), "utf8") : "" }))
  .filter((x) => x.src.length > 0);

function lastSegment(path: string): string {
  const clean = path.split("?")[0].split("#")[0].replace(/\/+$/, "");
  const parts = clean.split("/").filter(Boolean);
  return parts[parts.length - 1] ?? "";
}

function segmentExists(seg: string): boolean {
  if (!seg) return false;
  const esc = seg.replace(/[-/\\^$*+?.()|[\]{}]/g, "\\$&");
  // Accept any path="..." or path={"..."} literal whose value ends with this
  // segment (with or without a leading slash), since react-router nesting
  // means a registry path like /finance/reports/financial is matched by
  // <Route path="reports/financial"> inside <FinanceApp>.
  const re = new RegExp(`path=(?:\\{)?["'\`][^"'\`]*?/?${esc}["'\`]`);
  return haystacks.some((h) => re.test(h.src));
}

describe("REPORT_REGISTRY ⇄ react-router-dom parity", () => {
  for (const entry of REPORT_REGISTRY) {
    it(`route exists for ${entry.id} (${entry.path})`, () => {
      const seg = lastSegment(entry.path);
      expect(
        segmentExists(seg),
        `No <Route path="${seg}" /> found in App.tsx or any src/apps/*/routes.tsx for registry entry "${entry.id}" (${entry.path}). ` +
          `Either add the route in App.tsx / the relevant app routes.tsx file, or remove the entry from REPORT_REGISTRY.`,
      ).toBe(true);
    });
  }
});
