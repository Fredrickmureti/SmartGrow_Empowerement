/**
 * Wave 2 · Phase D — Architecture guard for the durable outbox dispatcher.
 *
 * These invariants prevent regressions after the outbox delivery substrate
 * lands:
 *
 *   1. The edge function file exists and uses the service role client
 *      (only server-role code may claim server-scope events).
 *   2. A migration wires the dead-letter table and the scope resolver.
 *   3. The browser BusinessSaga only claims 'host'-scope events — server
 *      events must be delivered by the durable dispatcher, not a tab.
 */
import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

const REPO = process.cwd();

describe("pos-outbox-dispatcher: durable delivery substrate", () => {
  it("has the outbox-dispatcher edge function with service-role client", () => {
    const src = readFileSync(
      join(REPO, "supabase/functions/outbox-dispatcher/index.ts"),
      "utf8",
    );
    expect(src).toMatch(/SUPABASE_SERVICE_ROLE_KEY/);
    expect(src).toMatch(/claim_next_business_event/);
    expect(src).toMatch(/p_handler_scope:\s*["']server["']/);
    expect(src).toMatch(/complete_business_event/);
  });

  it("has a migration adding the DLQ table and scope resolver", () => {
    const dir = join(REPO, "supabase/migrations");
    const files = readdirSync(dir).filter((f) => f.endsWith(".sql"));
    const hasDlq = files.some((f) =>
      /business_event_outbox_dead/.test(readFileSync(join(dir, f), "utf8")),
    );
    const hasScope = files.some((f) =>
      /pos_topic_handler_scope/.test(readFileSync(join(dir, f), "utf8")),
    );
    expect(hasDlq, "expected a migration creating business_event_outbox_dead").toBe(true);
    expect(hasScope, "expected a migration adding pos_topic_handler_scope").toBe(true);
  });

  it("browser BusinessSaga claims only host-scope events", () => {
    const src = readFileSync(join(REPO, "src/services/events/BusinessSaga.ts"), "utf8");
    // Must pass handler_scope='host' to the RPC
    expect(src).toMatch(/p_handler_scope:\s*['"]host['"]/);
    // Must not still be calling the un-scoped 3-arg shape
    expect(src).not.toMatch(
      /rpc\(\s*['"]claim_next_business_event['"][\s\S]*?\)\s*(?![\s\S]*p_handler_scope)/,
    );
  });
});
