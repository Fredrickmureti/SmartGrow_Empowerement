/**
 * Guardrail — ADR-0089 no-product-id-as-barcode ESLint rule catches the
 * exact "Lemonade UUID under the barcode" defect this ships to prevent.
 *
 * Runs the rule against synthetic sources rather than the live tree so
 * we exercise both the failure path (a `.id` fallback) and the success
 * path (a `resolveLabelBarcode` call).
 */
import { describe, it, expect } from "vitest";
import { RuleTester } from "eslint";
import rule from "../../../eslint-rules/no-product-id-as-barcode.js";

const tester = new RuleTester({
  languageOptions: {
    ecmaVersion: 2022,
    sourceType: "module",
  },
});

describe("no-product-id-as-barcode (ADR-0089)", () => {
  it("accepts resolveLabelBarcode-driven calls and flags .id fallbacks", () => {
    tester.run("no-product-id-as-barcode", rule, {
      valid: [
        {
          filename: "/repo/src/pages/Products.tsx",
          code: `
            printLabelByTemplate({
              orgId: 'o',
              templateKey: 'product_label',
              vars: { barcode: identity.code, sku_display: identity.skuDisplay },
            });
          `,
        },
        {
          filename: "/repo/src/pages/Products.tsx",
          code: `labelPrint.print({ templateKey: 'x', workflow: 'product_tag', product, vars: { barcode: identity.code } });`,
        },
        // Non-src files (tests, tools) exempt.
        {
          filename: "/repo/src/test/foo.test.ts",
          code: `printLabelByTemplate({ vars: { barcode: product.id } });`,
        },
      ],
      invalid: [
        {
          filename: "/repo/src/pages/Products.tsx",
          code: `printLabelByTemplate({ orgId: 'o', templateKey: 'k', vars: { barcode: product.barcode || product.sku || product.id } });`,
          errors: [{ messageId: "idAsBarcode" }],
        },
        {
          filename: "/repo/src/pages/Warehouse.tsx",
          code: `printLabelByTemplate({ vars: { barcode: item.id } });`,
          errors: [{ messageId: "idAsBarcode" }],
        },
        {
          filename: "/repo/src/pages/Pos.tsx",
          code: `foo.print({ vars: { barcode: product.id } });`,
          errors: [{ messageId: "idAsBarcode" }],
        },
      ],
    });
    expect(true).toBe(true);
  });
});
