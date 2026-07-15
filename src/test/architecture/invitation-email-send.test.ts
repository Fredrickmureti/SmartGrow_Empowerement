import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";

describe("invitation email send diagnostics", () => {
  it("routes app invitation emails through the shared checked helper", () => {
    const files = [
      "src/components/employees/EmployeeInviteDialog.tsx",
      "src/pages/Team.tsx",
      "src/pages/OnboardingSetup.tsx",
    ];

    for (const file of files) {
      const src = readFileSync(file, "utf8");
      expect(src, `${file} must use checked invitation sender`).toMatch(
        /sendInvitationEmailOrThrow/,
      );
      expect(src, `${file} must not invoke send-invitation-email directly`).not.toMatch(
        /functions\.invoke\(\s*["']send-invitation-email["']/,
      );
    }
  });

  it("extracts real HTTP function response bodies for diagnostics", () => {
    const src = readFileSync("src/lib/invitations/sendInvitationEmail.ts", "utf8");
    expect(src).toMatch(/FunctionsHttpError/);
    expect(src).toMatch(/error\.context\.text\(\)/);
    expect(src).toMatch(/details/);
  });
});