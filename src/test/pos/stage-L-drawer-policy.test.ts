/**
 * Stage L — useDrawerPolicy context matrix snapshot.
 *
 * Locks the cashier-fatigue contract: drawer fires on cash, stays shut on
 * card/mobile, and respects the per-register opt-in flags for refund / void
 * / reprint contexts.
 */
import { describe, it, expect } from "vitest";
import { renderHook } from "@testing-library/react";
import { useDrawerPolicy } from "@/hooks/pos/useDrawerPolicy";

const defaultReg = {
  auto_open_drawer_on_cash: true,
  auto_open_drawer_on_non_cash: false,
  drawer_kick_on_return: false,
  drawer_kick_on_void: false,
  drawer_kick_on_reprint: false,
};
const cashier = { can_open_cash_drawer: true };

const cash = [{ method: "cash", amount: 100 }];
const card = [{ method: "card", amount: 100 }];
const split = [
  { method: "cash", amount: 50 },
  { method: "card", amount: 50 },
];

describe("Stage L — drawer policy matrix", () => {
  it("cash sale: kick; card sale: no kick; split with cash: kick", () => {
    const { result } = renderHook(() =>
      useDrawerPolicy({ register: defaultReg, cashier }),
    );
    expect(result.current.shouldKickDrawer(cash)).toBe(true);
    expect(result.current.shouldKickDrawer(card)).toBe(false);
    expect(result.current.shouldKickDrawer(split)).toBe(true);
  });

  it("return / void / reprint: closed by default even on cash", () => {
    const { result } = renderHook(() =>
      useDrawerPolicy({ register: defaultReg, cashier }),
    );
    expect(result.current.shouldKickForContext("return", cash)).toBe(false);
    expect(result.current.shouldKickForContext("void", cash)).toBe(false);
    expect(result.current.shouldKickForContext("reprint", cash)).toBe(false);
  });

  it("return opt-in: kicks for cash refund, never for card refund", () => {
    const { result } = renderHook(() =>
      useDrawerPolicy({
        register: { ...defaultReg, drawer_kick_on_return: true },
        cashier,
      }),
    );
    expect(result.current.shouldKickForContext("return", cash)).toBe(true);
    expect(result.current.shouldKickForContext("return", card)).toBe(false);
  });

  it("void opt-in: kicks for cash void, never for card void", () => {
    const { result } = renderHook(() =>
      useDrawerPolicy({
        register: { ...defaultReg, drawer_kick_on_void: true },
        cashier,
      }),
    );
    expect(result.current.shouldKickForContext("void", cash)).toBe(true);
    expect(result.current.shouldKickForContext("void", card)).toBe(false);
  });

  it("cashier without can_open_cash_drawer: never kicks", () => {
    const { result } = renderHook(() =>
      useDrawerPolicy({
        register: { ...defaultReg, drawer_kick_on_return: true, drawer_kick_on_void: true },
        cashier: { can_open_cash_drawer: false },
      }),
    );
    expect(result.current.shouldKickDrawer(cash)).toBe(false);
    expect(result.current.shouldKickForContext("return", cash)).toBe(false);
    expect(result.current.shouldKickForContext("void", cash)).toBe(false);
    expect(result.current.shouldKickForContext("no_sale", [])).toBe(false);
  });

  it("no_sale / manual_open / cash_movement: always kick (caller explicitly asked)", () => {
    const { result } = renderHook(() =>
      useDrawerPolicy({ register: defaultReg, cashier }),
    );
    expect(result.current.shouldKickForContext("no_sale", [])).toBe(true);
    expect(result.current.shouldKickForContext("manual_open", [])).toBe(true);
    expect(result.current.shouldKickForContext("cash_movement", [])).toBe(true);
  });
});
