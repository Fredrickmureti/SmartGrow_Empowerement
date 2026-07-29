/**
 * Phase 4 §5 — two-context realtime contention smoke.
 *
 * Driver A and Driver B both sit on the operator task queue
 * (`/warehouse-app/tasks`). Driver A claims and completes a task via
 * `wms_claim_next_task` + `wms_transition_task`; Driver B's board must
 * drop that task within one realtime tick — no manual refresh, no poll.
 *
 * This is the multi-operator race the WMS brief calls out: two RF users
 * on the same warehouse must never both believe they hold the same work.
 *
 * RPCs exercised: wms_claim_next_task, wms_transition_task.
 */
import { test, expect } from "@playwright/test";
import { ensureSeed } from "../support/seed";
import { restoreSupabaseSession, authAvailable } from "../support/auth";

const url = process.env.VITE_SUPABASE_URL;
const anon = process.env.VITE_SUPABASE_PUBLISHABLE_KEY;

test.describe("wms/realtime-contention — Phase 4 §5", () => {
  test.beforeAll(() => {
    if (!authAvailable()) test.skip(true, "no injected supabase session");
    if (!url || !anon) test.skip(true, "supabase env vars missing");
  });

  test("a task completed by driver A leaves driver B's board on the realtime tick", async ({
    browser,
  }) => {
    const ctxA = await browser.newContext();
    const ctxB = await browser.newContext();
    const pageA = await ctxA.newPage();
    const pageB = await ctxB.newPage();
    await restoreSupabaseSession(ctxA, pageA);
    await restoreSupabaseSession(ctxB, pageB);

    const fixture = await ensureSeed(pageA);

    const rest = async (
      page: typeof pageA,
      path: string,
      init: { method?: string; body?: unknown } = {},
    ) =>
      page.evaluate(
        async ({ url, anon, path, init }) => {
          const key = Object.keys(window.localStorage).find(
            (k) => k.startsWith("sb-") && k.endsWith("-auth-token"),
          );
          const session = key ? JSON.parse(window.localStorage.getItem(key)!) : null;
          const token: string = session?.access_token;
          const res = await fetch(`${url}/rest/v1/${path}`, {
            method: init.method ?? "GET",
            headers: {
              apikey: anon,
              Authorization: `Bearer ${token}`,
              "Content-Type": "application/json",
              Prefer: "return=representation",
            },
            body: init.body ? JSON.stringify(init.body) : undefined,
          });
          const text = await res.text();
          if (!res.ok) throw new Error(`${path} → ${res.status} ${text}`);
          return text ? JSON.parse(text) : null;
        },
        { url, anon, path, init },
      );

    // Seed one uniquely-identifiable task both drivers can see.
    const marker = `E2E-CONTENTION-${Date.now()}`;
    const [seeded] = (await rest(pageA, "wms_tasks", {
      method: "POST",
      body: {
        organization_id: (fixture as unknown as { organization_id: string }).organization_id,
        business_id: fixture.business_id,
        branch_id: fixture.branch_id,
        warehouse_id: fixture.warehouse_id,
        task_type: "pick",
        state: "available",
        priority: 999,
        notes: marker,
      },
    })) as Array<{ id: string; row_version: number }>;

    // Both drivers open the queue and see the task.
    await pageA.goto("/warehouse-app/tasks");
    await pageB.goto("/warehouse-app/tasks");
    await expect(pageB.getByText(marker).first()).toBeVisible({ timeout: 20_000 });

    // Driver A claims then completes it.
    const claimed = (await rest(pageA, "rpc/wms_claim_next_task", {
      method: "POST",
      body: {
        _warehouse_id: fixture.warehouse_id,
        _task_types: ["pick"],
        _zone_id: null,
        _lease_seconds: 300,
      },
    })) as { id: string; row_version: number } | Array<{ id: string; row_version: number }> | null;
    const claimedRow = Array.isArray(claimed) ? claimed[0] : claimed;
    expect(claimedRow?.id).toBe(seeded.id);

    await rest(pageA, "rpc/wms_transition_task", {
      method: "POST",
      body: {
        _task_id: seeded.id,
        _to_state: "in_progress",
        _expected_version: claimedRow!.row_version,
        _reason: null,
        _payload_patch: {},
      },
    });
    const after = (await rest(
      pageA,
      `wms_tasks?id=eq.${seeded.id}&select=row_version`,
    )) as Array<{ row_version: number }>;
    await rest(pageA, "rpc/wms_transition_task", {
      method: "POST",
      body: {
        _task_id: seeded.id,
        _to_state: "completed",
        _expected_version: after[0].row_version,
        _reason: "e2e contention",
        _payload_patch: {},
      },
    });

    // Driver B never touched the page — realtime must retire the row.
    await expect(pageB.getByText(marker).first()).toBeHidden({ timeout: 20_000 });

    await ctxA.close();
    await ctxB.close();
  });
});
