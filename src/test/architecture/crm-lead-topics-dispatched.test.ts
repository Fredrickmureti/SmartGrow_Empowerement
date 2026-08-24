/**
 * The outbox dispatcher's HANDLERS map is a CLOSED registry: an event type with
 * no entry dead-letters as `unknown_event_type`. CRM lead lifecycle events are
 * emitted by a database trigger, so a missing dispatcher entry is invisible
 * until events pile up in `business_event_outbox_dead`.
 *
 * This ratchet keeps the emitted CRM topic set and the dispatcher map in sync.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const CRM_LEAD_TOPICS = [
  "crm.lead.qualified",
  "crm.lead.stage_changed",
  "crm.lead.won",
  "crm.lead.lost",
  "crm.lead.reopened",
  "crm.lead.reassigned",
  "crm.lead.revalued",
  "crm.lead.archived",
] as const;

describe("CRM lead lifecycle topics are dispatchable", () => {
  const source = readFileSync(
    resolve(process.cwd(), "supabase/functions/outbox-dispatcher/index.ts"),
    "utf8",
  );

  it.each(CRM_LEAD_TOPICS)("%s has a dispatcher handler", (topic) => {
    expect(source).toContain(`"${topic}":`);
  });
});
