/**
 * Architecture guard — AI conversation scope & multi-tenant isolation.
 *
 * 1. The client never declares its own role or accessible branches; the
 *    assistant edge function derives both from the caller's JWT.
 * 2. Every browser-side read of `ai_conversations` carries an explicit
 *    `organization_id` predicate; message reads are keyed by `conversation_id`.
 * 3. Conversation history is not sourced solely from client state — the
 *    assistant hook must bind to a persisted conversation.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { globSync } from "glob";

const SRC_FILES = globSync("src/**/*.{ts,tsx}", { nodir: true }).filter(
  (f) =>
    !f.includes("__tests__") &&
    !f.endsWith(".test.ts") &&
    !f.endsWith(".test.tsx") &&
    !f.includes("integrations/supabase/types"),
);

const CONVERSATION_TABLES = ["ai_conversations", "ai_conversation_messages"];

describe("AI conversation scope", () => {
  it("no browser module sends userRole or accessibleBranchIds to the assistant", () => {
    const offenders = SRC_FILES.filter((file) =>
      /\baccessibleBranchIds\b/.test(readFileSync(file, "utf8")),
    );
    expect(offenders).toEqual([]);
  });


  it("the assistant edge function does not accept role or branch scope from the body", () => {
    const src = readFileSync("supabase/functions/ai-assistant/index.ts", "utf8");
    const bodyDestructure = src.match(/}: AIRequest = await req\.json\(\);/);
    expect(bodyDestructure).not.toBeNull();
    const interfaceBlock = src.slice(
      src.indexOf("interface AIRequest"),
      src.indexOf("}: AIRequest = await req.json();"),
    );
    const declared = interfaceBlock.slice(0, interfaceBlock.indexOf("}\n"));
    expect(declared).not.toMatch(/userRole\?:/);
    expect(declared).not.toMatch(/accessibleBranchIds\?:/);
  });

  it("every conversation query in the browser is tenant- or thread-scoped", () => {
    const offenders: string[] = [];
    for (const file of SRC_FILES) {
      const src = readFileSync(file, "utf8");
      for (const table of CONVERSATION_TABLES) {
        if (!src.includes(`"${table}"`)) continue;
        const predicate =
          table === "ai_conversations"
            ? /organization_id/.test(src)
            : /conversation_id/.test(src);
        if (!predicate) offenders.push(`${file}:${table}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it("the assistant hook binds turns to a persisted conversation", () => {
    const src = readFileSync("src/hooks/useAIAssistant.ts", "utf8");
    expect(src).toMatch(/ensureConversation/);
    expect(src).toMatch(/conversationId: threadId/);
    // Only the new user turn may be trusted from the client once a thread exists.
    expect(src).toMatch(/\[\{ role: "user", content: userMessage \}\]/);
  });

  it("the AI insights cache is keyed on the full tenant/branch/app scope", () => {
    const src = readFileSync("src/hooks/useAIInsightsCache.ts", "utf8");
    // Cache reads and writes must always carry the tenant predicate…
    expect(src).toMatch(/\.eq\("organization_id", currentOrg\.id\)/);
    // …and the branch + app dimensions, null-aware for company-wide entries.
    expect(src).toMatch(/eq\("branch_id", branchId\)/);
    expect(src).toMatch(/is\("branch_id", null\)/);
    expect(src).toMatch(/eq\("app_key", scopedAppKey\)/);
    expect(src).toMatch(/is\("app_key", null\)/);
  });

  it("no browser module queries ai_insights_cache without an organization predicate", () => {
    const offenders = SRC_FILES.filter((file) => {
      const src = readFileSync(file, "utf8");
      return src.includes('"ai_insights_cache"') && !/organization_id/.test(src);
    });
    expect(offenders).toEqual([]);
  });

  it("AI usage logs are written with a server-derived scope tuple", () => {
    const src = readFileSync("supabase/functions/ai-assistant/index.ts", "utf8");
    expect(src).toMatch(/interface UsageScope/);
    expect(src).toMatch(/from\("ai_usage_logs"\)\.insert\(\{[\s\S]{0,400}organization_id: usageScope\.organizationId/);
    expect(src).toMatch(/branch_id: usageScope\.branchId/);
    expect(src).toMatch(/app_key: usageScope\.appKey/);
    // The scope must be derived server-side, never taken from the request body.
    expect(src).toMatch(/userId: callerUserId \?\? null/);
  });

  it("every allowlisted data table declares a module requirement", () => {
    const tools = readFileSync("supabase/functions/ai-assistant/dataTools.ts", "utf8");
    const caps = readFileSync("supabase/functions/ai-assistant/capabilities.ts", "utf8");
    const tablesBlock = tools.slice(tools.indexOf("DATA_TABLES"), tools.indexOf("const MAX_LIMIT"));
    const tables = [...tablesBlock.matchAll(/^ {2}(\w+): \{/gm)].map((m) => m[1]);
    expect(tables.length).toBeGreaterThan(10);
    const mapBlock = caps.slice(caps.indexOf("TABLE_MODULE"), caps.indexOf("TOOL_MODULE"));
    const mapped = new Set([...mapBlock.matchAll(/^ {2}(\w+): "/gm)].map((m) => m[1]));
    expect(tables.filter((t) => !mapped.has(t))).toEqual([]);
  });

  it("every advertised tool is dispatched and capability-gated", () => {
    const tools = readFileSync("supabase/functions/ai-assistant/dataTools.ts", "utf8");
    const advertised = [...tools.matchAll(/name: "(\w+)",\n\s+description:/g)].map((m) => m[1]);
    expect(advertised.length).toBeGreaterThan(3);
    const exec = tools.slice(tools.indexOf("export async function executeDataTool"));
    for (const name of advertised) {
      expect(exec).toContain(`"${name}"`);
      expect(tools).toMatch(new RegExp(`${name}:`)); // present in TOOL_MODULE import usage
    }
    // Deny by default: unknown tools are rejected before any read.
    expect(exec).toMatch(/if \(!\(name in TOOL_MODULE\)\) return \{ error/);
    expect(exec).toMatch(/canReadModule\(caps, TOOL_MODULE\[name\]\)/);
    expect(exec).toMatch(/canReadTable\(caps, table\)/);
  });

  it("branch narrowing fails closed for non-admin callers", () => {
    const tools = readFileSync("supabase/functions/ai-assistant/dataTools.ts", "utf8");
    // No `accessibleBranchIds?.length` guard may gate the branch predicate.
    expect(tools).not.toMatch(/!scope\.isAdmin && scope\.accessibleBranchIds\?\.length/);
    expect(tools).toMatch(/ids\.length \? ids : \[IMPOSSIBLE_UUID\]/);

    const index = readFileSync("supabase/functions/ai-assistant/index.ts", "utf8");
    expect(index).not.toMatch(/if \(!isAdmin && branchIds\.length > 0\) \{\n\s+\/\/ Filter POS/);
  });

  it("the requested business and branch scope is validated server-side", () => {
    const src = readFileSync("supabase/functions/ai-assistant/index.ts", "utf8");
    expect(src).toMatch(/forbidden: business is not part of this organization/);
    expect(src).toMatch(/forbidden: no access to this business/);
    expect(src).toMatch(/forbidden: no access to this branch/);
  });

  it("the context snapshot is trimmed to the caller's readable modules", () => {
    const src = readFileSync("supabase/functions/ai-assistant/index.ts", "utf8");
    expect(src).toMatch(/resolveCapabilities\(supabaseClient, callerUserId, organizationId\)/);
    expect(src).toMatch(/scrubContextByCapabilities\(financialContext, capabilities\)/);
    expect(src).toMatch(/buildDataToolSpecs\(scope\.capabilities\)/);
  });
});


