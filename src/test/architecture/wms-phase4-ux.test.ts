/**
 * Architecture guard — Phase 4 (UX & error-proofing).
 *
 * Pins three invariants that are cheap to break by accident:
 *
 * 1. Operator feedback has ONE implementation. Warehouse mobile code may not
 *    hand-roll `navigator.vibrate` or an AudioContext beep — otherwise tone,
 *    volume, and haptic length drift per screen and the mute toggle stops
 *    working for whichever screen forgot it.
 * 2. The outbox emitter writes the REAL `business_event_outbox` columns and
 *    does not swallow errors. The original body inserted `topic` /
 *    `organization_id` (neither exists) inside an exception handler, so every
 *    warehouse transition event was silently dropped. Never again.
 * 3. Exception triage sends a `resolution_kind`. The RPC rejects terminal
 *    states without one; the guard keeps the client honest.
 */
import { describe, it, expect } from "vitest";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

const FEEDBACK_HOOK = "src/features/warehouse/scanning/useScanFeedback.tsx";

function walk(dir: string, out: string[] = []): string[] {
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return out;
  }
  for (const name of entries) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (/\.(ts|tsx)$/.test(name)) out.push(full);
  }
  return out;
}

function readMigrations(): string {
  return walk("supabase/migrations")
    .filter((f) => f.endsWith(".sql") || true)
    .map((f) => readFileSync(f, "utf8"))
    .join("\n");
}

function allMigrationSql(): string {
  const files = readdirSync("supabase/migrations").filter((f) => f.endsWith(".sql"));
  return files
    .sort()
    .map((f) => readFileSync(join("supabase/migrations", f), "utf8"))
    .join("\n-- ---- \n");
}

describe("Phase 4 · scan feedback is centralised", () => {
  it("only useScanFeedback implements audio/haptic feedback", () => {
    const files = [
      ...walk("src/apps/warehouse-mobile"),
      ...walk("src/pages/warehouse-mobile"),
      ...walk("src/features/warehouse"),
    ];
    const offenders = files
      .map((f) => f.replace(/\\/g, "/"))
      .filter((rel) => rel !== FEEDBACK_HOOK)
      .filter((rel) => {
        const src = readFileSync(rel, "utf8");
        return /navigator\s*\.\s*vibrate|new\s+(window\.)?(webkit)?AudioContext|createOscillator/.test(
          src,
        );
      });
    expect(
      offenders,
      `Warehouse screens must use useScanFeedback() (or emitScanOutcome()) ` +
        `instead of hand-rolled beeps/vibration, so tone, haptics, and the ` +
        `mute toggle stay uniform.\n\nOffenders:\n${offenders.join("\n")}`,
    ).toEqual([]);
  });

  it("the mobile layout mounts the feedback bridge", () => {
    const src = readFileSync("src/apps/warehouse-mobile/MobileWarehouseLayout.tsx", "utf8");
    expect(src).toMatch(/useScanFeedbackBridge\(\)/);
    expect(src).toMatch(/<Flash\s*\/>/);
  });

  it("the offline queue emits an outcome on every terminal path", () => {
    const src = readFileSync("src/apps/warehouse-mobile/offlineQueue.ts", "utf8");
    expect(src).toMatch(/emitScanOutcome\("success"\)/);
    expect(src).toMatch(/emitScanOutcome\("warn"\)/);
    expect(src).toMatch(/emitScanOutcome\("error"\)/);
  });
});

describe("Phase 4 · outbox emission is real and loud", () => {
  const sql = allMigrationSql();
  // Anchor on the last CREATE (not the COMMENT ON, which mentions the same name).
  // Bound the slice to the emitter's OWN definition: anything after the next
  // CREATE belongs to a later, unrelated function and must not be asserted on
  // (the body delimiter is not always `$function$`).
  const emitterStart = sql.lastIndexOf("CREATE OR REPLACE FUNCTION public._wms_emit_outbox");
  const nextCreate = sql.indexOf("CREATE OR REPLACE FUNCTION", emitterStart + 1);
  const lastEmitter = sql.slice(emitterStart, nextCreate === -1 ? undefined : nextCreate);

  it("_wms_emit_outbox targets the actual business_event_outbox columns", () => {
    expect(lastEmitter).toMatch(/INSERT INTO public\.business_event_outbox/);
    for (const col of ["org_id", "event_type", "source_doc_type", "source_doc_id"]) {
      expect(lastEmitter, `emitter must write ${col}`).toMatch(new RegExp(`\\b${col}\\b`));
    }
  });

  it("_wms_emit_outbox does not write columns that do not exist", () => {
    // The historic bug: `topic` and `organization_id` are not columns on
    // business_event_outbox, so every insert raised undefined_column.
    const insertBlock = lastEmitter.slice(
      lastEmitter.indexOf("INSERT INTO public.business_event_outbox"),
    );
    expect(insertBlock).not.toMatch(/^\s*topic\s*,/m);
    expect(insertBlock).not.toMatch(/\borganization_id\s*,/);
  });

  it("_wms_emit_outbox never swallows exceptions", () => {
    expect(lastEmitter).not.toMatch(/EXCEPTION\s+WHEN/i);
  });
});

describe("Phase 4 · exception triage is typed", () => {
  // Phase 5 moved the drill-down out of the inbox page into the single
  // ExceptionDetailSheet; the inbox is now list + filters only.
  const sheet = readFileSync("src/features/warehouse/exceptions/ExceptionDetailSheet.tsx", "utf8");
  const page = readFileSync("src/pages/warehouse/ExceptionsInbox.tsx", "utf8");

  it("sends p_resolution_kind to wms_resolve_exception", () => {
    expect(sheet).toMatch(/p_resolution_kind/);
  });

  it("blocks terminal transitions until a cause is chosen", () => {
    const terminalButtons = sheet.match(/disabled=\{[^}]*\}[\s\S]{0,240}?transition\("(resolved|wont_fix)"\)/g) ?? [];
    expect(terminalButtons.length).toBe(2);
    for (const btn of terminalButtons) {
      expect(btn, `terminal transition must require a resolution kind:\n${btn}`).toMatch(
        /!resolutionKind/,
      );
    }
  });

  it("surfaces the SLA due date and the event trail", () => {
    expect(page).toMatch(/due_by/);
    expect(sheet).toMatch(/due_by/);
    expect(sheet).toMatch(/wms_exception_events/);
  });
});


// Keep the unused-import linter honest about the helper above.
void readMigrations;

describe("Phase 4 §1 · every WMS aggregate exposes its event trail", () => {
  const CALL_SITES: Array<[string, string]> = [
    ["src/pages/warehouse/LicensePlateView.tsx", "ActivitySection"],
    ["src/pages/warehouse/PickList.tsx", "ActivitySection"],
    ["src/pages/warehouse/LoadingBay.tsx", "ActivitySection"],
    ["src/pages/warehouse/QCInspectionDetail.tsx", "ActivitySection"],
    ["src/pages/warehouse/CountSession.tsx", "ActivitySection"],
    ["src/pages/warehouse/ReceivingSessions.tsx", "ActivityHistoryButton"],
  ];

  it("all six aggregate surfaces render the timeline", () => {
    for (const [file, symbol] of CALL_SITES) {
      const src = readFileSync(file, "utf8");
      expect(src, `${file} must render <${symbol} />`).toMatch(
        new RegExp(`<${symbol}[\\s/>]`),
      );
    }
  });

  it("OutboxTimeline is the only reader of business_event_outbox in warehouse UI", () => {
    const files = [
      ...walk("src/pages/warehouse"),
      ...walk("src/pages/warehouse-mobile"),
      ...walk("src/features/warehouse"),
      ...walk("src/apps/warehouse"),
      ...walk("src/apps/warehouse-mobile"),
    ].filter((f) => !f.endsWith("OutboxTimeline.tsx"));
    for (const f of files) {
      const src = readFileSync(f, "utf8");
      expect(src, `${f} must not query business_event_outbox directly`).not.toMatch(
        /from\(\s*["']business_event_outbox["']/,
      );
    }
  });
});

describe("Phase 4 §6 · role dashboards are wired and event-driven", () => {
  // ADR 0102 — the supervisor tower merged into the Warehouse Overview.
  // The Overview composes feature hooks rather than querying directly, so it
  // is asserted separately below.
  const DASHBOARDS = [
    "src/pages/warehouse/InboundDashboard.tsx",
    "src/pages/warehouse/OutboundDashboard.tsx",
  ];
  const routes = readFileSync("src/apps/warehouse/routes.tsx", "utf8");
  const nav = readFileSync("src/apps/warehouse/nav.ts", "utf8");

  it("each dashboard exists, is routed, and is reachable from the nav", () => {
    for (const f of DASHBOARDS) {
      expect(readFileSync(f, "utf8").length, `${f} missing`).toBeGreaterThan(0);
    }
    for (const path of ["dashboard/inbound", "dashboard/outbound"]) {
      expect(routes, `route ${path} not wired`).toContain(`path="${path}"`);
      expect(nav, `nav entry for ${path} missing`).toContain(`/warehouse-app/${path}`);
    }
  });

  // The tower pages no longer fetch: each composes its feature barrel, where
  // business scoping and realtime-invalidated query keys live. Assert that
  // boundary instead of re-asserting the query shape in page code.
  it("dashboards fetch through their feature module, never inline", () => {
    for (const f of DASHBOARDS) {
      const src = readFileSync(f, "utf8");
      expect(src, `${f} must not poll`).not.toMatch(/refetchInterval/);
      expect(src, `${f} must not query Supabase directly`).not.toMatch(
        /from\(\s*["'][a-z_]+["']\s*\)/,
      );
      expect(src, `${f} must compose a warehouse feature module`).toMatch(
        /@\/features\/warehouse\/(inbound-tower|outbound-tower|control-center)/,
      );
    }
  });

  it("tower feature modules are business-scoped and realtime-invalidated", () => {
    const sync = readFileSync("src/features/warehouse/realtime/useWmsRealtimeSync.ts", "utf8");
    for (const [hook, prefixes] of [
      ["src/features/warehouse/inbound-tower/useInboundTower.ts", "INBOUND_QUERY_PREFIXES"],
      ["src/features/warehouse/outbound-tower/useOutboundTower.ts", "OUTBOUND_QUERY_PREFIXES"],
    ] as const) {
      const src = readFileSync(hook, "utf8");
      expect(src, `${hook} must scope by business`).toMatch(/p_business_id|eq\("business_id"/);
      expect(src, `${hook} must not poll`).not.toMatch(/refetchInterval/);
      expect(sync, `${prefixes} must be invalidated by realtime`).toContain(prefixes);
    }
  });


  it("ADR 0102 · there is exactly one warehouse command centre", () => {
    expect(existsSync("src/pages/warehouse/SupervisorDashboard.tsx"), "supervisor tower must be removed").toBe(false);
    expect(existsSync("src/pages/warehouse/WarehouseDashboard.tsx"), "legacy setup dashboard must be removed").toBe(false);

    const overview = readFileSync("src/pages/warehouse/WarehouseOverview.tsx", "utf8");
    expect(routes).toContain("<WarehouseOverview />");
    expect(nav, "overview must be the nav home").toContain('/warehouse-app/dashboard", label: "Overview"');
    expect(nav, "supervisor tower nav entry must be gone").not.toContain("dashboard/supervisor");
    expect(routes, "supervisor deep link must redirect").toContain(
      'path="dashboard/supervisor" element={<Navigate to="/warehouse-app/dashboard" replace />}',
    );

    // The Overview aggregates owning modules; it must not fetch or poll itself.
    expect(overview, "overview must not query Supabase directly").not.toMatch(/supabase\s*\n?\s*\./);
    expect(overview, "overview must not poll").not.toMatch(/refetchInterval/);
  });

  it("ADR 0102 · overview lenses are realtime-invalidated", () => {
    const sync = readFileSync("src/features/warehouse/realtime/useWmsRealtimeSync.ts", "utf8");
    expect(sync).toContain("OVERVIEW_QUERY_PREFIXES");
  });
});

