/**
 * The sales-analysis engine must only compare enum status columns to real
 * labels. `credit_note_status` has no `cancelled` and no `voided`; filtering
 * on those made Postgres raise 22P02 at plan time and PostgREST return HTTP
 * 400 for the whole Sales Reports page, regardless of data.
 */
import { describe, it, expect } from "vitest";
import {
  ENUM_LABELS,
  invalidStatusLiterals,
  latestMigrationDefining,
} from "./support/enumStatusLiterals";

const FUNCTIONS = ["finance_sales_analysis", "finance_sales_revenue_reconciliation"];

describe.each(FUNCTIONS)("%s compares status columns to real enum labels", (fn) => {
  const sql = latestMigrationDefining(fn);

  for (const table of Object.keys(ENUM_LABELS)) {
    it(`uses only valid ${table}.status labels`, () => {
      expect(invalidStatusLiterals(sql, table), `invalid ${table}.status literal(s)`).toEqual([]);
    });
  }
});
