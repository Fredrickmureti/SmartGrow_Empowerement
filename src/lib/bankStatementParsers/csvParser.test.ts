import { describe, it, expect } from "vitest";
import { detectHeaderRowIndex, buildColumns } from "./csvParser";
import { applyColumnMapping } from "./index";

/**
 * Meridian Commercial Bank export shape: preamble rows populate only the first
 * column, and the sheet is padded to the widest row — the exact shape that used
 * to produce empty-string header labels and crash the mapping Select.
 */
const meridianRows: string[][] = [
  ["Meridian Commercial Bank", "", "", "", ""],
  ["Account: 010000000001", "", "", "", ""],
  ["Currency: KES", "", "", "", ""],
  ["Date", "Description", "Debit", "Credit", "Balance"],
  ["01-Aug-2026", "Opening balance", "", "", "10000.00"],
  ["05-Aug-2026", "Payment received - Fredrick Mureti - INV-00002", "", "1670.40", "11670.40"],
  ["07-Aug-2026", "Bank service charge", "350.00", "", "11320.40"],
  ["09-Aug-2026", "Bank transfer", "2000.00", "", "9320.40"],
];

const columnsOf = (rows: string[][]) => {
  const idx = detectHeaderRowIndex(rows);
  return buildColumns(rows[idx], rows.slice(idx + 1));
};

describe("statement column detection", () => {
  it("skips bank preamble rows and finds the real header row", () => {
    expect(detectHeaderRowIndex(meridianRows)).toBe(3);
  });

  it("never emits an empty or duplicate column key", () => {
    const cases: string[][][] = [
      meridianRows,
      // blank trailing columns
      [
        ["Date", "Description", "Amount", "", ""],
        ["2026-08-05", "Deposit", "1670.40", "", ""],
      ],
      // duplicate labels
      [
        ["Date", "Amount", "Amount", "Description"],
        ["2026-08-05", "10", "20", "Deposit"],
      ],
      // blank header cell that still carries data
      [
        ["Date", "", "Description"],
        ["2026-08-05", "X", "Deposit"],
      ],
    ];

    for (const rows of cases) {
      const cols = columnsOf(rows);
      const keys = cols.map((c) => c.key);
      expect(keys.every((k) => k.trim() !== "")).toBe(true);
      expect(new Set(keys).size).toBe(keys.length);
    }
  });

  it("drops columns that are blank in the header and empty in every row", () => {
    const cols = columnsOf([
      ["Date", "Description", "Amount", "", ""],
      ["2026-08-05", "Deposit", "1670.40", "", ""],
    ]);
    expect(cols.map((c) => c.key)).toEqual(["Date", "Description", "Amount"]);
  });

  it("keeps a blank-headered column that carries data, under a positional key", () => {
    const cols = columnsOf([
      ["Date", "", "Description"],
      ["2026-08-05", "X", "Deposit"],
    ]);
    expect(cols.map((c) => c.key)).toEqual(["Date", "Column B", "Description"]);
  });
});

describe("applyColumnMapping over detected columns", () => {
  const cols = columnsOf(meridianRows);
  const rows = meridianRows.slice(4);

  it("maps separate credit/debit columns off the Meridian statement", () => {
    const txns = applyColumnMapping(
      cols,
      rows,
      { date: "Date", description: "Description", amount: "", reference: "", credit: "Credit", debit: "Debit", balance: "Balance" },
      "acct-1",
    );

    const mureti = txns.find((t) => t.description.includes("Fredrick Mureti"));
    expect(mureti).toBeDefined();
    expect(mureti!.date).toBe("2026-08-05");
    expect(mureti!.type).toBe("credit");
    expect(mureti!.amount).toBeCloseTo(1670.4, 2);

    const charge = txns.find((t) => t.description === "Bank service charge");
    expect(charge!.type).toBe("debit");
    expect(charge!.amount).toBeCloseTo(350, 2);
  });

  it("resolves duplicate labels positionally instead of collapsing them", () => {
    const dupRows = [
      ["Date", "Amount", "Amount", "Description"],
      ["2026-08-05", "10", "20", "Deposit"],
    ];
    const dupCols = columnsOf(dupRows);
    expect(dupCols.map((c) => c.key)).toEqual(["Date", "Amount", "Amount (2)", "Description"]);

    const txns = applyColumnMapping(
      dupCols,
      dupRows.slice(1),
      { date: "Date", description: "Description", amount: "Amount (2)", reference: "" },
      "acct-1",
    );
    expect(txns[0].amount).toBe(20);
  });

  it("handles a single signed amount column, credit-only and debit-only files", () => {
    const rowsSigned = [
      ["Date", "Description", "Amount"],
      ["2026-08-05", "Deposit", "1670.40"],
      ["2026-08-07", "Charge", "-350.00"],
    ];
    const c = columnsOf(rowsSigned);
    const txns = applyColumnMapping(
      c,
      rowsSigned.slice(1),
      { date: "Date", description: "Description", amount: "Amount", reference: "" },
      "acct-1",
    );
    expect(txns.map((t) => t.type)).toEqual(["credit", "debit"]);
  });

  it("returns nothing rather than throwing when required columns are unmapped", () => {
    expect(applyColumnMapping(cols, rows, { date: "", description: "", amount: "", reference: "" }, "acct-1")).toEqual([]);
  });
});

describe("amount normalization across statement layouts", () => {
  it("excludes the opening-balance row (Balance only, no credit/debit)", () => {
    const cols = columnsOf(meridianRows);
    const txns = applyColumnMapping(
      cols,
      meridianRows.slice(4),
      { date: "Date", description: "Description", amount: "", reference: "", credit: "Credit", debit: "Debit", balance: "Balance" },
      "acct-1",
    );
    expect(txns.some((t) => t.description === "Opening balance")).toBe(false);
    expect(txns).toHaveLength(3);
  });

  it("normalizes Withdrawal/Deposit and Money Out/Money In to the same signed model", () => {
    const layouts: Array<{ rows: string[][]; credit: string; debit: string }> = [
      {
        rows: [
          ["Date", "Description", "Withdrawal", "Deposit"],
          ["2026-08-05", "Deposit", "", "1670.40"],
          ["2026-08-07", "Charge", "350.00", ""],
        ],
        credit: "Deposit",
        debit: "Withdrawal",
      },
      {
        rows: [
          ["Date", "Description", "Money Out", "Money In"],
          ["2026-08-05", "Deposit", "", "1670.40"],
          ["2026-08-07", "Charge", "350.00", ""],
        ],
        credit: "Money In",
        debit: "Money Out",
      },
    ];

    for (const { rows, credit, debit } of layouts) {
      const txns = applyColumnMapping(
        columnsOf(rows),
        rows.slice(1),
        { date: "Date", description: "Description", amount: "", reference: "", credit, debit },
        "acct-1",
      );
      expect(txns.map((t) => [t.type, t.amount])).toEqual([
        ["credit", 1670.4],
        ["debit", 350],
      ]);
    }
  });

  it("never treats the balance column as the transaction amount", () => {
    const cols = columnsOf(meridianRows);
    const txns = applyColumnMapping(
      cols,
      meridianRows.slice(4),
      { date: "Date", description: "Description", amount: "", reference: "", credit: "Credit", debit: "Debit", balance: "Balance" },
      "acct-1",
    );
    for (const t of txns) {
      expect(t.amount).not.toBe(t.balance);
    }
    expect(txns.find((t) => t.description.includes("Mureti"))!.amount).toBeCloseTo(1670.4, 2);
  });
});
