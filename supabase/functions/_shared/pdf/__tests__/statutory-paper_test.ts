/**
 * ADR-0008 Phase T2 — statutory paper pins reject continuous roll.
 *
 * Statutory generators (payslip, tax certificate, statutory return, audit
 * certificate) call `assertStatutoryPaper` to refuse any attempt to
 * re-paper a regulator-locked document. Continuous-roll thermal media
 * must be rejected explicitly — both the "continuous" sentinel string
 * and the concrete thermal preset names.
 */
import { assertStatutoryPaper } from "../index.ts";

function expectThrows(fn: () => void, needle: string, label: string) {
  let thrown: unknown = null;
  try {
    fn();
  } catch (e) {
    thrown = e;
  }
  if (!thrown) throw new Error(`${label}: expected throw, got none`);
  const msg = (thrown as Error).message ?? String(thrown);
  if (!msg.includes(needle)) {
    throw new Error(`${label}: expected message to include "${needle}", got "${msg}"`);
  }
}

Deno.test("assertStatutoryPaper accepts fixed statutory sheets", () => {
  for (const ok of ["a4", "A4", "letter", "a4-landscape", "legal"]) {
    assertStatutoryPaper(ok); // must not throw
  }
});

Deno.test("assertStatutoryPaper rejects continuous sentinel", () => {
  expectThrows(() => assertStatutoryPaper("continuous"), "continuous", "continuous");
  expectThrows(() => assertStatutoryPaper("auto"), "auto", "auto (deprecated alias)");
});

Deno.test("assertStatutoryPaper rejects thermal presets", () => {
  for (const bad of ["80mm", "58mm", "40mm"]) {
    expectThrows(() => assertStatutoryPaper(bad), bad, `thermal preset ${bad}`);
  }
});
