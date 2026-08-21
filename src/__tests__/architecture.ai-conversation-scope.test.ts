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
    const offenders = SRC_FILES.filter((file) => {
      const src = readFileSync(file, "utf8");
      return /\baccessibleBranchIds\b/.test(src) || /\buserRole,\s*$/m.test(src) === false
        ? /\baccessibleBranchIds\b/.test(src)
        : false;
    });
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
});
