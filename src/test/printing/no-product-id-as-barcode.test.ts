/**
 * Guardrail — ADR-0089 no-product-id-as-barcode ESLint rule catches the
 * exact "Lemonade UUID under the barcode" defect this ships to prevent.
 *
 * RuleTester wraps its own describe/it, so it MUST be invoked at module
 * top level — not inside a describe/it callback.
 */
import { RuleTester } from "eslint";
import rule from "../../../eslint-rules/no-product-id-as-barcode.js";

const tester = new RuleTester({
  languageOptions: {
    ecmaVersion: 2022,
    sourceType: "module",
  },
});

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
