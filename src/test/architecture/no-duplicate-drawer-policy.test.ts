/**
 * Stage F architecture guard — `useDrawerPolicy` is the single canonical
 * resolver for "should the cash drawer kick?". No other client file may read
 * the raw `pos_registers.auto_open_drawer_on_cash` / `..._on_non_cash`
 * columns or re-implement the decision.
 *
 * Allowed exceptions:
 *   - the hook itself
 *   - generated Supabase types
 *   - the EditRegisterDialog (write-side settings form)
 *   - this guard file
 */
import { describe, it, expect } from "vitest";
import { execSync } from "node:child_process";
import { readFileSync } from "node:fs";

const ALLOWLIST = [
  /^src\/hooks\/pos\/useDrawerPolicy\.ts$/,
  /^src\/integrations\/supabase\/types\.ts$/,
  /^src\/components\/pos\/EditRegisterDialog\.tsx$/,
  /^src\/test\/architecture\/no-duplicate-drawer-policy\.test\.ts$/,
];

describe("POS architecture guard — drawer policy is single-sourced", () => {
  it("no client file reads auto_open_drawer_on_cash outside the canonical hook", () => {
    const candidates = execSync(
      'rg --files-with-matches "auto_open_drawer_on_cash|auto_open_drawer_on_non_cash" src/ || true',
      { encoding: "utf8" },
    )
      .split("\n")
      .filter(Boolean)
      .filter((p) => !ALLOWLIST.some((re) => re.test(p)));

    expect(
      candidates,
      `Files reading the raw drawer-policy columns outside useDrawerPolicy:\n${candidates.join(
        "\n",
      )}\nUse useDrawerPolicy().shouldKickDrawer(payments) instead.`,
    ).toEqual([]);
  });

  it("no client file re-implements shouldKickDrawer", () => {
    const offenders = execSync(
      'rg --files-with-matches "shouldKickDrawer" src/ || true',
      { encoding: "utf8" },
    )
      .split("\n")
      .filter(Boolean)
      .filter(
        (p) =>
          !/^src\/hooks\/pos\/useDrawerPolicy\.ts$/.test(p) &&
          !/^src\/pages\/pos\/POSTerminal\.tsx$/.test(p) &&
          !/^src\/test\//.test(p),
      );

    expect(
      offenders,
      `shouldKickDrawer is defined/used outside the canonical surface:\n${offenders.join("\n")}`,
    ).toEqual([]);
  });
});
