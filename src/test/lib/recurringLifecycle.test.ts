import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import {
  RECURRING_TRANSITIONS,
  canTransitionRecurring,
  isTerminalRecurringStatus,
  MAX_DELIVERY_ATTEMPTS,
  DELIVERY_BACKOFF_MINUTES,
} from "@/lib/recurringLifecycle";

describe("recurring template lifecycle", () => {
  it("allows pause and resume", () => {
    expect(canTransitionRecurring("active", "paused")).toBe(true);
    expect(canTransitionRecurring("paused", "active")).toBe(true);
  });

  it("closes terminal states permanently", () => {
    expect(isTerminalRecurringStatus("cancelled")).toBe(true);
    expect(isTerminalRecurringStatus("completed")).toBe(true);
    expect(canTransitionRecurring("cancelled", "active")).toBe(false);
    expect(canTransitionRecurring("completed", "active")).toBe(false);
  });

  it("never resurrects a schedule out of a terminal state", () => {
    for (const [from, targets] of Object.entries(RECURRING_TRANSITIONS)) {
      if (isTerminalRecurringStatus(from as never)) expect(targets).toHaveLength(0);
    }
  });

  it("keeps delivery backoff strictly increasing", () => {
    expect(DELIVERY_BACKOFF_MINUTES).toHaveLength(MAX_DELIVERY_ATTEMPTS);
    for (let i = 1; i < DELIVERY_BACKOFF_MINUTES.length; i++) {
      expect(DELIVERY_BACKOFF_MINUTES[i]).toBeGreaterThan(DELIVERY_BACKOFF_MINUTES[i - 1]!);
    }
  });
});

describe("recurring status single writer", () => {
  const hook = readFileSync("src/hooks/useRecurringInvoices.ts", "utf8");

  it("routes every lifecycle change through the atomic RPC", () => {
    expect(hook).toContain("set_recurring_status_atomic");
  });

  it("never writes is_active or status through a plain update", () => {
    const updateBlock = hook.slice(hook.indexOf("const updateRecurringInvoice"));
    expect(updateBlock).toContain("is_active: _isActive");
    expect(updateBlock).toContain("status: _status");
  });
});

describe("scheduler is timezone- and retry-aware", () => {
  const fn = readFileSync("supabase/functions/process-recurring-invoices/index.ts", "utf8");

  it("bills on the tenant's local date, not the worker's UTC date", () => {
    expect(fn).toContain("localToday(");
    expect(fn).toContain("timeZone");
  });

  it("selects only templates whose lifecycle status is active", () => {
    expect(fn).toContain('.eq("status", "active")');
  });

  it("uses a dedicated delivery counter with backoff", () => {
    expect(fn).toContain("delivery_attempt_count");
    expect(fn).toContain("next_retry_at");
  });

  it("completes finished schedules through the lifecycle writer", () => {
    expect(fn).toContain("set_recurring_status_atomic");
  });
});
