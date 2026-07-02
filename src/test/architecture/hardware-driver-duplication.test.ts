/**
 * Architecture guard (Wave 6) — every renderer driver in
 * `src/services/hardware/drivers/DriverRegistry.ts` whose `driver_type`
 * is also covered by a main-process driver in `electron/hardware/drivers/`
 * MUST be registered with `{ browserFallback: true }`.
 *
 * The main process is the production hardware runtime; the renderer driver
 * should only run when Electron is absent. A renderer driver registered
 * WITHOUT the flag will silently win even inside Electron if the main-side
 * one fails to construct — exactly the kind of fragmentation that the
 * Wave-6 plan retired.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import path from "path";

const REG = path.resolve(__dirname, "../../services/hardware/drivers/DriverRegistry.ts");
const SRC = readFileSync(REG, "utf8");

/** Driver-type strings that the main process owns. Keep in sync with
 *  `electron/hardware/drivers/index.ts` → `buildDriver()`. */
const MAIN_COVERED_DRIVER_TYPES = [
  "escpos", "star", "citizen", "bixolon", "epson",     // receipt/kitchen
  "escpos_drawer",                                      // cash drawer
  "generic_scale", "toledo_scale", "cas_scale", "mettler_scale", // scale
  "secondary_screen_display",                           // customer display
  "browser_print",                                      // print fallback
  "epos_printer",                                       // LAN HTTP printer
];

describe("hardware driver duplication (Wave 6)", () => {
  for (const type of MAIN_COVERED_DRIVER_TYPES) {
    it(`registerDriver('${type}', …) is marked browserFallback: true`, () => {
      const re = new RegExp(
        `registerDriver\\(\\s*['"]${type}['"][\\s\\S]*?browserFallback:\\s*true`,
      );
      expect(
        re.test(SRC),
        `Renderer driver '${type}' overlaps a main-process driver but is not flagged browserFallback: true.`,
      ).toBe(true);
    });
  }
});
