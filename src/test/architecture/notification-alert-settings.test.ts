/**
 * Architecture guard for notification_alert_settings save path.
 *
 * Background regression: the alert thresholds page was hitting
 *   `invalid input syntax for type timestamp with time zone: ""`
 * because the hook synthesised `id/created_at/updated_at: ""` when no row
 * existed and the form spread that whole object back into the upsert.
 *
 * The architecturally correct fix:
 *   1. Hook never returns empty-string timestamps.
 *   2. All saves go through a typed RPC (`upsert_notification_alert_settings`)
 *      that whitelists + validates the payload server-side.
 *   3. Range validation (reminder frequency, hour 0..23, etc.) lives in a
 *      Zod schema exported from the hook and is exercised before any DB call.
 */
import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

import {
  notificationAlertSettingsSchema,
} from "@/hooks/useNotificationAlertSettings";

describe("notification alert settings — save contract", () => {
  it("Zod schema rejects an out-of-range arrears reminder frequency", () => {
    const r = notificationAlertSettingsSchema.safeParse({
      overdue_reminder_frequency_days: 0,
      overdue_escalation_enabled: true,
      payment_received_notify: true,
      large_payment_threshold: 1000,
      expense_approval_required_above: 500,
      daily_digest_enabled: false,
      weekly_digest_enabled: true,
      digest_send_hour: 8,
      digest_timezone: "Africa/Nairobi",
    });
    expect(r.success).toBe(false);
  });

  it("Zod schema rejects digest_send_hour out of range", () => {
    const base = {
      overdue_reminder_frequency_days: 7,
      overdue_escalation_enabled: true,
      payment_received_notify: true,
      large_payment_threshold: 1000,
      expense_approval_required_above: 500,
      daily_digest_enabled: false,
      weekly_digest_enabled: true,
      digest_send_hour: 24,
      digest_timezone: "Africa/Nairobi",
    };
    expect(notificationAlertSettingsSchema.safeParse(base).success).toBe(false);
  });

  it("Zod schema rejects negative thresholds", () => {
    const r = notificationAlertSettingsSchema.safeParse({
      overdue_reminder_frequency_days: 7,
      overdue_escalation_enabled: true,
      payment_received_notify: true,
      large_payment_threshold: -1,
      expense_approval_required_above: 500,
      daily_digest_enabled: false,
      weekly_digest_enabled: true,
      digest_send_hour: 8,
      digest_timezone: "Africa/Nairobi",
    });
    expect(r.success).toBe(false);
  });

  it("hook source must NOT synthesize empty-string timestamps in fallback", () => {
    const src = readFileSync(
      "src/hooks/useNotificationAlertSettings.ts",
      "utf8",
    );
    // Must not contain the legacy decorative empty strings:
    expect(src).not.toMatch(/created_at:\s*['"]['"]/);
    expect(src).not.toMatch(/updated_at:\s*['"]['"]/);
    expect(src).not.toMatch(/id:\s*['"]['"]/);
  });

  it("hook must call the typed RPC, not raw .upsert(notification_alert_settings)", () => {
    const src = readFileSync(
      "src/hooks/useNotificationAlertSettings.ts",
      "utf8",
    );
    expect(src).toMatch(/upsert_notification_alert_settings/);
    expect(src).not.toMatch(
      /from\(['"]notification_alert_settings['"]\)\s*\.\s*upsert/,
    );
  });

  it("a migration must define upsert_notification_alert_settings as SECURITY DEFINER", () => {
    const dir = "supabase/migrations";
    const files = readdirSync(dir).filter((f) => f.endsWith(".sql")).sort();
    let found = false;
    for (let i = files.length - 1; i >= 0; i--) {
      const sql = readFileSync(join(dir, files[i]), "utf8");
      if (
        /CREATE\s+OR\s+REPLACE\s+FUNCTION\s+public\.upsert_notification_alert_settings/i.test(
          sql,
        ) &&
        /SECURITY\s+DEFINER/i.test(sql) &&
        /search_path\s*=\s*public/i.test(sql)
      ) {
        found = true;
        break;
      }
    }
    expect(
      found,
      "upsert_notification_alert_settings must be defined SECURITY DEFINER with search_path=public",
    ).toBe(true);
  });
});
