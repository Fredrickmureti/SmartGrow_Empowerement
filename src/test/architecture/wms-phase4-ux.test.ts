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
import { readdirSync, readFileSync, statSync } from "node:fs";
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
  const lastEmitter = sql.slice(
    sql.lastIndexOf("CREATE OR REPLACE FUNCTION public._wms_emit_outbox"),
  );

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
      lastEmitter.indexOf("$function$", lastEmitter.indexOf("INSERT INTO")),
    );
    expect(insertBlock).not.toMatch(/^\s*topic\s*,/m);
    expect(insertBlock).not.toMatch(/\borganization_id\s*,/);
  });

  it("_wms_emit_outbox never swallows exceptions", () => {
    expect(lastEmitter.slice(0, lastEmitter.indexOf("$function$;") + 1)).not.toMatch(
      /EXCEPTION\s+WHEN/i,
    );
  });
});

describe("Phase 4 · exception triage is typed", () => {
  const page = readFileSync("src/pages/warehouse/ExceptionsInbox.tsx", "utf8");

  it("sends p_resolution_kind to wms_resolve_exception", () => {
    expect(page).toMatch(/p_resolution_kind/);
  });

  it("blocks terminal transitions until a cause is chosen", () => {
    const terminalButtons = page.match(/to: "(resolved|wont_fix)"[\s\S]{0,240}?disabled=\{[^}]*\}/g) ?? [];
    expect(terminalButtons.length).toBe(2);
    for (const btn of terminalButtons) {
      expect(btn, `terminal transition must require a resolution kind:\n${btn}`).toMatch(
        /!resolutionKind/,
      );
    }
  });

  it("surfaces the SLA due date and the event trail", () => {
    expect(page).toMatch(/due_by/);
    expect(page).toMatch(/OutboxTimeline/);
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
  const DASHBOARDS = [
    "src/pages/warehouse/InboundDashboard.tsx",
    "src/pages/warehouse/OutboundDashboard.tsx",
    "src/pages/warehouse/SupervisorDashboard.tsx",
  ];
  const routes = readFileSync("src/apps/warehouse/routes.tsx", "utf8");
  const nav = readFileSync("src/apps/warehouse/nav.ts", "utf8");

  it("each dashboard exists, is routed, and is reachable from the nav", () => {
    for (const f of DASHBOARDS) {
      expect(readFileSync(f, "utf8").length, `${f} missing`).toBeGreaterThan(0);
    }
    for (const path of ["dashboard/inbound", "dashboard/outbound", "dashboard/supervisor"]) {
      expect(routes, `route ${path} not wired`).toContain(`path="${path}"`);
      expect(nav, `nav entry for ${path} missing`).toContain(`/warehouse-app/${path}`);
    }
  });

  it("dashboard queries use realtime-invalidated key prefixes (no polling)", () => {
    const ALLOWED_PREFIXES = [
      "wms_tasks",
      "wms_exceptions",
      "wms-pick-waves",
      "wms-pack-cartons",
      "wms-loading-manifests",
      "wms-receiving-sessions",
      "wms-dock-appointments",
    ];
    for (const f of DASHBOARDS) {
      const src = readFileSync(f, "utf8");
      expect(src, `${f} must not poll`).not.toMatch(/refetchInterval/);
      const keys = [...src.matchAll(/queryKey:\s*\[\s*"([a-z_0-9-]+)"/g)].map((m) => m[1]);
      expect(keys.length, `${f} has no queries`).toBeGreaterThan(0);
      for (const k of keys) {
        expect(ALLOWED_PREFIXES, `${f} uses un-invalidated key prefix "${k}"`).toContain(k);
      }
    }
  });

  it("dashboards are business-scoped", () => {
    for (const f of DASHBOARDS) {
      const src = readFileSync(f, "utf8");
      expect(src, `${f} must filter by business_id`).toMatch(/eq\("business_id"/);
    }
  });
});
