import { describe, it, expect } from "vitest";
import { formatInstallerError } from "@/features/localization/lib/installerError";

describe("formatInstallerError", () => {
  it("maps PAYROLL_NOT_INSTALLED to the actionable title", () => {
    const out = formatInstallerError({
      code: "PAYROLL_NOT_INSTALLED",
      error: "Payroll app is not installed",
      step: "assert_app",
      sqlstate: "P0001",
      pg_message: "APP_NOT_INSTALLED: payroll",
    });
    expect(out.title).toBe("Install the Payroll app first");
    expect(out.description).toContain("step=assert_app");
    expect(out.description).toContain("sqlstate=P0001");
    expect(out.description).toContain("APP_NOT_INSTALLED");
  });

  it("maps INSTALL_CHECK_VIOLATION (23514) to integrity-check title", () => {
    const out = formatInstallerError({
      code: "INSTALL_CHECK_VIOLATION",
      error: "Pack failed an integrity check",
      sqlstate: "23514",
    });
    expect(out.title).toBe("Pack integrity check failed");
    expect(out.description).toContain("sqlstate=23514");
  });

  it("falls back to the generic title for an unknown code", () => {
    const out = formatInstallerError({ error: "boom" });
    expect(out.title).toBe("Failed to install localization pack");
    expect(out.description).toBe("boom");
  });

  it("uses fallbackMessage when the body has nothing usable", () => {
    const out = formatInstallerError({}, "Network unreachable");
    expect(out.description).toContain("Network unreachable");
  });
});
