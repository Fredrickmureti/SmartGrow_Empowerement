import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { parseAssistantContent, ACTION_BLOCK_PROTOCOL_PROMPT } from "@/lib/ai/actionBlocks";
import { ROUTE_CATALOG, isCatalogId, buildCatalogPromptBlock } from "@/lib/ai/routeCatalog";

/**
 * Read every router-bearing source file once so we can grep them for
 * registered route segments. This guards against the AI emitting
 * deep-links to paths the router never defined.
 */
const ROUTER_SOURCES = [
  "src/App.tsx",
  "src/apps/hr/sub/PayrollRoutes.tsx",
  "src/apps/hr/sub/EmployeesRoutes.tsx",
  "src/apps/hr/sub/AttendanceRoutes.tsx",
  "src/apps/hr/sub/TimeOffRoutes.tsx",
  "src/apps/hr/routes.tsx",
  "src/apps/finance/routes.tsx",
  "src/apps/inventory/routes.tsx",
  "src/apps/sales/routes.tsx",
  "src/apps/purchases/routes.tsx",
  "src/apps/pos/routes.tsx",
  "src/apps/projects/routes.tsx",
  "src/apps/contacts/routes.tsx",
  "src/apps/crm/routes.tsx",
  "src/apps/timesheets/routes.tsx",
  "src/pages/Settings.tsx",
]
  .map((p) => {
    try {
      return readFileSync(resolve(process.cwd(), p), "utf8");
    } catch {
      return "";
    }
  })
  .join("\n");

/**
 * A path "resolves" if either:
 *   - one of its tail segments matches a `path="..."` declaration in the
 *     router source (catches both flat and nested route declarations), OR
 *   - it is a `/settings/<hub>?tab=...` deep-link and the tab id appears in
 *     the Settings router whitelist.
 */
function pathResolves(rawPath: string): boolean {
  const [pathname, query] = rawPath.split("?");
  if (pathname.startsWith("/settings/")) {
    const tab = new URLSearchParams(query || "").get("tab");
    if (tab && ROUTER_SOURCES.includes(`"${tab}"`)) return true;
    if (!tab && pathname === "/settings") return true;
  }
  if (pathname === "/apps") {
    return ROUTER_SOURCES.includes('path="/apps"') || ROUTER_SOURCES.includes('path="apps"');
  }
  const segs = pathname.split("/").filter(Boolean);
  for (let take = Math.min(2, segs.length); take >= 1; take--) {
    const candidate = segs.slice(-take).join("/");
    if (ROUTER_SOURCES.includes(`path="${candidate}"`)) return true;
    if (ROUTER_SOURCES.includes(`path="${candidate}/*"`)) return true;
  }
  return false;
}

describe("AI route catalog", () => {
  it("every entry has a unique non-empty path", () => {
    const ids = Object.keys(ROUTE_CATALOG);
    const paths = ids.map((id) => ROUTE_CATALOG[id].path);
    expect(new Set(paths).size).toBe(paths.length);
    for (const id of ids) {
      expect(ROUTE_CATALOG[id].path.startsWith("/")).toBe(true);
      expect(ROUTE_CATALOG[id].label.length).toBeGreaterThan(0);
    }
  });

  it("every catalog path resolves to a real route in the router source", () => {
    const broken: string[] = [];
    for (const id of Object.keys(ROUTE_CATALOG)) {
      if (!pathResolves(ROUTE_CATALOG[id].path)) {
        broken.push(`${id} → ${ROUTE_CATALOG[id].path}`);
      }
    }
    expect(broken, `Catalog entries with non-existent routes:\n${broken.join("\n")}`).toEqual([]);
  });

  it("isCatalogId guards against unknown ids", () => {
    expect(isCatalogId("payroll.gl_mappings")).toBe(true);
    expect(isCatalogId("payroll.bogus")).toBe(false);
  });

  it("catalog prompt block lists every entry", () => {
    const block = buildCatalogPromptBlock();
    for (const id of Object.keys(ROUTE_CATALOG)) {
      expect(block).toContain(id);
    }
  });
});

describe("Action block parser", () => {
  it("returns clean text + actions for valid blocks", () => {
    const raw = [
      "Here's what to do next:",
      "",
      '::action {"type":"open_path","path_id":"payroll.gl_mappings","label":"Open GL Mapping fixer"}',
      '::action {"type":"fix_gl_mappings","label":"Fix payroll mappings now"}',
    ].join("\n");
    const { text, actions } = parseAssistantContent(raw);
    expect(text).toBe("Here's what to do next:");
    expect(actions).toHaveLength(2);
    expect(actions[0]).toMatchObject({ type: "open_path", path_id: "payroll.gl_mappings" });
    expect(actions[1].type).toBe("fix_gl_mappings");
  });

  it("drops actions referencing unknown path_ids", () => {
    const raw = [
      "Hello",
      '::action {"type":"open_path","path_id":"payroll.does_not_exist","label":"Nope"}',
    ].join("\n");
    const { text, actions } = parseAssistantContent(raw);
    expect(text).toBe("Hello");
    expect(actions).toHaveLength(0);
  });

  it("ignores malformed action JSON without throwing", () => {
    const raw = "Hi\n::action {not json";
    const { text, actions } = parseAssistantContent(raw);
    expect(text).toBe("Hi");
    expect(actions).toHaveLength(0);
  });

  it("returns content unchanged when no action prefix is present", () => {
    const { text, actions } = parseAssistantContent("just markdown");
    expect(text).toBe("just markdown");
    expect(actions).toEqual([]);
  });

  it("protocol prompt mentions the action prefix", () => {
    expect(ACTION_BLOCK_PROTOCOL_PROMPT).toContain("::action ");
  });
});
