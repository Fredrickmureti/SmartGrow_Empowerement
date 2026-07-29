/**
 * Phase 3.6 — Labour claim race.
 *
 * Two independent Supabase sessions race `wms_claim_next_task` for the
 * same warehouse. `wms_claim_next_task` uses `FOR UPDATE SKIP LOCKED`,
 * so the two calls MUST return different task ids (or one succeeds and
 * the other returns null when only a single open task exists) — the
 * same task must never be handed to both operators.
 *
 * After the race we also assert that `business_event_outbox` contains
 * exactly one `warehouse.task.assigned` row per winning task_id, which
 * proves the single-producer property (trigger owns emission, RPC does
 * not double-emit).
 */
import { test, expect } from "@playwright/test";
import { ensureSeed } from "../support/seed";
import { restoreSupabaseSession, authAvailable } from "../support/auth";

const url = process.env.VITE_SUPABASE_URL;
const anon = process.env.VITE_SUPABASE_PUBLISHABLE_KEY;

test.describe("wms/labour-claim — Phase 3.6", () => {
  test.beforeAll(() => {
    if (!authAvailable()) test.skip(true, "no injected supabase session");
    if (!url || !anon) test.skip(true, "supabase env vars missing");
  });

  test("two racers never claim the same task, exactly one outbox event per claim", async ({
    browser,
  }) => {
    // Two contexts share the same injected Supabase session — the
    // race we care about is RPC concurrency, not multi-tenant auth.
    const ctxA = await browser.newContext();
    const ctxB = await browser.newContext();
    const pageA = await ctxA.newPage();
    const pageB = await ctxB.newPage();
    await restoreSupabaseSession(ctxA, pageA);
    await restoreSupabaseSession(ctxB, pageB);

    const fixture = await ensureSeed(pageA);

    // Seed 4 open pick tasks so the race has headroom.
    const seeded = await pageA.evaluate(
      async ({ url, anon, fixture }) => {
        const key = Object.keys(window.localStorage).find(
          (k) => k.startsWith("sb-") && k.endsWith("-auth-token"),
        );
        const session = key ? JSON.parse(window.localStorage.getItem(key)!) : null;
        const token: string = session?.access_token;
        const ids: string[] = [];
        for (let i = 0; i < 4; i++) {
          const res = await fetch(`${url}/rest/v1/wms_tasks`, {
            method: "POST",
            headers: {
              apikey: anon,
              Authorization: `Bearer ${token}`,
              "Content-Type": "application/json",
              Prefer: "return=representation",
            },
            body: JSON.stringify({
              organization_id: fixture.organization_id,
              business_id: fixture.business_id,
              warehouse_id: fixture.warehouse_id,
              branch_id: fixture.branch_id,
              task_type: "pick",
              state: "available",
              priority: 100 - i,
            }),
          });
          if (!res.ok) throw new Error(`seed task ${i} → ${res.status} ${await res.text()}`);
          const [row] = await res.json();
          ids.push(row.id);
        }
        return ids;
      },
      { url, anon, fixture },
    );

    const claim = async (page: typeof pageA) =>
      page.evaluate(
        async ({ url, anon, fixture }) => {
          const key = Object.keys(window.localStorage).find(
            (k) => k.startsWith("sb-") && k.endsWith("-auth-token"),
          );
          const session = key ? JSON.parse(window.localStorage.getItem(key)!) : null;
          const token: string = session?.access_token;
          const res = await fetch(`${url}/rest/v1/rpc/wms_claim_next_task`, {
            method: "POST",
            headers: {
              apikey: anon,
              Authorization: `Bearer ${token}`,
              "Content-Type": "application/json",
            },
            body: JSON.stringify({
              _warehouse_id: fixture.warehouse_id,
              _task_types: ["pick"],
              _zone_id: null,
              _lease_seconds: 300,
            }),
          });
          if (!res.ok) throw new Error(`claim → ${res.status} ${await res.text()}`);
          return res.json();
        },
        { url, anon, fixture },
      );

    // Race the two claims in parallel.
    const [a, b] = await Promise.all([claim(pageA), claim(pageB)]);

    const idA = (a as { id?: string } | null)?.id ?? null;
    const idB = (b as { id?: string } | null)?.id ?? null;

    // At least one must have won; if both won they must be distinct.
    expect([idA, idB].some(Boolean)).toBe(true);
    if (idA && idB) expect(idA).not.toBe(idB);
    for (const claimed of [idA, idB].filter(Boolean)) {
      expect(seeded).toContain(claimed);
    }

    // Assert single-producer: exactly one `warehouse.task.assigned`
    // outbox row per winning task_id.
    const winners = [idA, idB].filter(Boolean) as string[];
    const outbox = await pageA.evaluate(
      async ({ url, anon, winners }) => {
        const key = Object.keys(window.localStorage).find(
          (k) => k.startsWith("sb-") && k.endsWith("-auth-token"),
        );
        const session = key ? JSON.parse(window.localStorage.getItem(key)!) : null;
        const token: string = session?.access_token;
        const rows: Array<{ source_doc_id: string; event_type: string }> = [];
        for (const id of winners) {
          const res = await fetch(
            `${url}/rest/v1/business_event_outbox` +
              `?source_doc_id=eq.${id}&event_type=eq.warehouse.task.assigned` +
              `&select=source_doc_id,event_type`,
            { headers: { apikey: anon, Authorization: `Bearer ${token}` } },
          );
          if (res.ok) rows.push(...(await res.json()));
        }
        return rows;
      },
      { url, anon, winners },
    );

    for (const id of winners) {
      const forId = outbox.filter((r) => r.source_doc_id === id);
      expect(forId.length, `expected exactly one assigned event for ${id}`).toBe(1);
    }

    await ctxA.close();
    await ctxB.close();
  });
});