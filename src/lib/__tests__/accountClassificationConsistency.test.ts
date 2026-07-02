/**
 * Classification Consistency Tests
 * 
 * Ensures all detail types are consistently mapped across
 * accountDetailTypes.ts, accountDetailTypeClassification.ts,
 * and AccountClassification.ts.
 */
import { describe, it, expect } from "vitest";
import { ACCOUNT_DETAIL_TYPES, ACCOUNT_CATEGORIES } from "../accountDetailTypes";
import {
  DETAIL_TYPE_CLASSIFICATION,
  isValidDetailTypeForAccountType,
} from "../accountDetailTypeClassification";

// Collect all detail_type values from the catalog
const allCatalogDetailTypes = new Set<string>();
for (const [, types] of Object.entries(ACCOUNT_DETAIL_TYPES)) {
  for (const dt of types) {
    allCatalogDetailTypes.add(dt.value);
  }
}

// Collect all detail_type values from category mappings
const allCategoryDetailTypes = new Set<string>();
for (const cat of ACCOUNT_CATEGORIES) {
  for (const dt of cat.detailTypes) {
    allCategoryDetailTypes.add(dt);
  }
}

describe("Detail Type Classification Consistency", () => {
  it("every detail_type in ACCOUNT_DETAIL_TYPES has a DETAIL_TYPE_CLASSIFICATION entry", () => {
    const missing: string[] = [];
    for (const dt of allCatalogDetailTypes) {
      if (!DETAIL_TYPE_CLASSIFICATION[dt]) missing.push(dt);
    }
    expect(missing).toEqual([]);
  });

  it("every detail_type in DETAIL_TYPE_CLASSIFICATION exists in ACCOUNT_DETAIL_TYPES", () => {
    const extra: string[] = [];
    for (const key of Object.keys(DETAIL_TYPE_CLASSIFICATION)) {
      if (!allCatalogDetailTypes.has(key)) extra.push(key);
    }
    expect(extra).toEqual([]);
  });

  it("every detail_type in ACCOUNT_CATEGORIES exists in ACCOUNT_DETAIL_TYPES", () => {
    const missing: string[] = [];
    for (const dt of allCategoryDetailTypes) {
      if (!allCatalogDetailTypes.has(dt)) missing.push(dt);
    }
    expect(missing).toEqual([]);
  });

  it("every detail_type in ACCOUNT_DETAIL_TYPES is referenced in at least one ACCOUNT_CATEGORIES", () => {
    const unreferenced: string[] = [];
    for (const dt of allCatalogDetailTypes) {
      if (!allCategoryDetailTypes.has(dt)) unreferenced.push(dt);
    }
    expect(unreferenced).toEqual([]);
  });

  it("isValidDetailTypeForAccountType returns true for all catalog entries matched to their base type", () => {
    const failures: string[] = [];
    for (const [accountType, types] of Object.entries(ACCOUNT_DETAIL_TYPES)) {
      for (const dt of types) {
        if (!isValidDetailTypeForAccountType(dt.value, accountType)) {
          failures.push(`${accountType}/${dt.value}`);
        }
      }
    }
    expect(failures).toEqual([]);
  });

  it("isValidDetailTypeForAccountType returns false for cross-type combinations", () => {
    // Asset detail types should not be valid for liability
    expect(isValidDetailTypeForAccountType("checking", "liability")).toBe(false);
    expect(isValidDetailTypeForAccountType("accounts_payable", "asset")).toBe(false);
    expect(isValidDetailTypeForAccountType("sales_income", "expense")).toBe(false);
    expect(isValidDetailTypeForAccountType("cost_of_goods_sold", "income")).toBe(false);
    expect(isValidDetailTypeForAccountType("owners_equity", "asset")).toBe(false);
  });

  it("every ACCOUNT_CATEGORIES entry has a valid baseType", () => {
    const validTypes = ["asset", "liability", "equity", "income", "expense"];
    for (const cat of ACCOUNT_CATEGORIES) {
      expect(validTypes).toContain(cat.baseType);
    }
  });

  it("category detail types belong to the correct base account type", () => {
    const failures: string[] = [];
    for (const cat of ACCOUNT_CATEGORIES) {
      for (const dt of cat.detailTypes) {
        if (!isValidDetailTypeForAccountType(dt, cat.baseType)) {
          failures.push(`${cat.value}/${dt} should be valid for ${cat.baseType}`);
        }
      }
    }
    expect(failures).toEqual([]);
  });
});
