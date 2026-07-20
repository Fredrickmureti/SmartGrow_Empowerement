import js from "@eslint/js";
import globals from "globals";
import reactHooks from "eslint-plugin-react-hooks";
import reactRefresh from "eslint-plugin-react-refresh";
import tseslint from "typescript-eslint";
import requireBusinessScope from "./eslint-rules/require-business-scope.js";
import noConditionalRadixOverlay from "./eslint-rules/no-conditional-radix-overlay.js";
import noLiteralRuleCodesInEngines from "./eslint-rules/no-literal-rule-codes-in-engines.js";
import noRawReceivedByRender from "./eslint-rules/no-raw-received-by-render.js";
import noRawHardwareIpc from "./eslint-rules/no-raw-hardware-ipc.js";
import noRawErrorMessageInToast from "./eslint-rules/no-raw-error-message-in-toast.js";
import noDirectPdfIframe from "./eslint-rules/no-direct-pdf-iframe.js";
import noRawInstalledAppsLoadingGate from "./eslint-rules/no-raw-installed-apps-loading-gate.js";
import noNavigateForLoadingState from "./eslint-rules/no-navigate-for-loading-state.js";
import noPrintserviceShim from "./eslint-rules/no-printservice-shim.js";
import noDirectWindowPrint from "./eslint-rules/no-direct-window-print.js";
import noDocumentPrintShadowPath from "./eslint-rules/no-document-print-shadow-path.js";
import noRawZplOutsidePrinting from "./eslint-rules/no-raw-zpl-outside-printing.js";
import noDirectEmployeesBranchWrite from "./eslint-rules/no-direct-employees-branch-write.js";
import noPayslipLinesInCertificates from "./eslint-rules/no-payslip-lines-in-certificates.js";
import noDialogCrudInAdmin from "./eslint-rules/no-dialog-crud-in-admin.js";
import noHandRolledMeHeader from "./eslint-rules/no-hand-rolled-me-header.js";
import noShellLeakFromMe from "./eslint-rules/no-shell-leak-from-me.js";
import noPdfLibInLocalizationPreview from "./eslint-rules/no-pdf-lib-in-localization-preview.js";
import noCountryFixtureInSharedPreview from "./eslint-rules/no-country-fixture-in-shared-preview.js";
import noPosCommitWithoutIdempotencyKey from "./eslint-rules/no-pos-commit-without-idempotency-key.js";
import noRawPdfLibInApp from "./eslint-rules/no-raw-pdf-lib-in-app.js";
import noDirectBarcodeLib from "./eslint-rules/no-direct-barcode-lib.js";
import noRawXlsxInApp from "./eslint-rules/no-raw-xlsx-in-app.js";
import noRawEscposBytes from "./eslint-rules/no-raw-escpos-bytes.js";
import noRawPdfLibInEdgeFunctions from "./eslint-rules/no-raw-pdf-lib-in-edge-functions.js";



export default tseslint.config(
  { ignores: ["dist"] },
  {
    extends: [js.configs.recommended, ...tseslint.configs.recommended],
    files: ["**/*.{ts,tsx}"],
    languageOptions: {
      ecmaVersion: 2020,
      globals: globals.browser,
    },
    plugins: {
      "react-hooks": reactHooks,
      "react-refresh": reactRefresh,
      local: {
        rules: {
          "require-business-scope": requireBusinessScope,
          "no-conditional-radix-overlay": noConditionalRadixOverlay,
          "no-literal-rule-codes-in-engines": noLiteralRuleCodesInEngines,
          "no-raw-received-by-render": noRawReceivedByRender,
          "no-raw-hardware-ipc": noRawHardwareIpc,
          "no-raw-error-message-in-toast": noRawErrorMessageInToast,
          "no-direct-pdf-iframe": noDirectPdfIframe,
          "no-raw-installed-apps-loading-gate": noRawInstalledAppsLoadingGate,
          "no-navigate-for-loading-state": noNavigateForLoadingState,
          "no-printservice-shim": noPrintserviceShim,
          "no-direct-window-print": noDirectWindowPrint,
          "no-document-print-shadow-path": noDocumentPrintShadowPath,
          "no-raw-zpl-outside-printing": noRawZplOutsidePrinting,
          "no-direct-employees-branch-write": noDirectEmployeesBranchWrite,
          "no-payslip-lines-in-certificates": noPayslipLinesInCertificates,
          "no-dialog-crud-in-admin": noDialogCrudInAdmin,
          "no-hand-rolled-me-header": noHandRolledMeHeader,
          "no-shell-leak-from-me": noShellLeakFromMe,
          "no-pdf-lib-in-localization-preview": noPdfLibInLocalizationPreview,
          "no-country-fixture-in-shared-preview": noCountryFixtureInSharedPreview,
          "no-pos-commit-without-idempotency-key": noPosCommitWithoutIdempotencyKey,
          "no-raw-pdf-lib-in-app": noRawPdfLibInApp,
          "no-direct-barcode-lib": noDirectBarcodeLib,
          "no-raw-xlsx-in-app": noRawXlsxInApp,
          "no-raw-escpos-bytes": noRawEscposBytes,
          "no-raw-pdf-lib-in-edge-functions": noRawPdfLibInEdgeFunctions,

        },
      },
    },
    rules: {
      ...reactHooks.configs.recommended.rules,
      "react-refresh/only-export-components": ["warn", { allowConstantExport: true }],
      "@typescript-eslint/no-unused-vars": "off",
      // Architecture guard: every .eq("organization_id", ...) on a multi-tenant
      // table must be paired with .eq("business_id", ...) in the same chain,
      // or carry a // SCOPE-EXEMPT: <reason> marker. See architecture audit B1.
      // Phase 1C of Zero-Trust audit: escalated from `warn` to `error` so CI
      // fails on every unscoped query.
      "local/require-business-scope": "error",
      // Overlay guard: forbids `cond && <Dialog/Sheet/AlertDialog/Drawer>`,
      // which leaks Radix's body `pointer-events: none` and freezes the UI.
      // See docs/architecture/OVERLAYS.md.
      "local/no-conditional-radix-overlay": "error",
      // Round 5: raw `.received_by` renders are UUID-leak risks. Resolve
      // through @/lib/recipientName before display.
      "local/no-raw-received-by-render": "error",
      // ADR-0014 Track H2 — escalated from `warn` to `error` after the
      // legacy `window.electronAPI` surface was removed from preload and
      // every src/ consumer was migrated to `window.pos.*`.
      "local/no-raw-hardware-ipc": "error",
      // Resilience guard: every error surfaced to users must go through
      // normalizeError() from @/services/resilience. Codemod swept all
      // 320 sites (2026-05-19); rule is now enforced at error-level.
      "local/no-raw-error-message-in-toast": "error",
      // ADR-0015 (Electron document preview): every PDF/HTML preview must
      // funnel through SafePdfViewer / SafeHtmlPreview. Raw <iframe> blob
      // previews silently break under Electron file://.
      "local/no-direct-pdf-iframe": "error",
      // Workspace install-state hydration guard: gating install-aware UI
      // on useInstalledApps().isLoading races against the React Query
      // hydration window. Use useWorkspaceContextReady({ appId }) instead.
      // See .lovable/plan.md → "Workspace install-state hydration".
      "local/no-raw-installed-apps-loading-gate": "error",
      // ADR-0034: URL = user intent, not loading bookkeeping. Route guards
      // must never <Navigate to="/select-organization"> to signal loading
      // / empty workspace state — render <NoWorkspaceEmptyState/> in place
      // via useWorkspaceRouting instead.
      "local/no-navigate-for-loading-state": "error",
      // ADR-0026 (cross-app print router) — lock the PrintClient chokepoint:
      // (1) reject print-service shims outside src/services/printing/, (2)
      // reject direct window.print() outside pdfUtils, (3) freeze the
      // useDocumentPrint shadow path to its current allowlisted surfaces
      // (entries removed as Wave B1 Step 3 migrates them).
      "local/no-printservice-shim": "error",
      "local/no-direct-window-print": "error",
      "local/no-document-print-shadow-path": "error",
      // Wave B2.2 — raw ZPL string literals are forbidden in src/ except the
      // printing dispatcher and the driver layer. Forces every label body
      // through label_templates + printLabelByTemplate so branch overrides
      // and template versioning actually take effect.
      "local/no-raw-zpl-outside-printing": "error",

      // HR Architecture Review — branch is a 0..N assignment, not an
      // ownership column. All writes go through assign_employee_to_branch /
      // transfer_employee_primary_branch. DB trigger enforces the same.
      "local/no-direct-employees-branch-write": "error",

      // ADR 0082 · Batch T2 — every process_pos_transaction call must
      // pass a deterministic p_idempotency_key. Fallbacks to
      // crypto.randomUUID() silently defeat retry-collapse.
      "local/no-pos-commit-without-idempotency-key": "error",



      // Platform stewardship — Phase F guardrail.
      // The unified workspace shell is `@/components/layout/shell/PlatformShell`
      // (re-exported from `@/design-system`). The pre-consolidation shell
      // components below are deprecated and exist only so unmigrated legacy
      // modules keep working during the workspace-by-workspace migration.
      // New code MUST NOT import them — compose pages from PlatformShell +
      // design-system primitives instead. See docs/design-system.md.
      "no-restricted-imports": [
        "error",
        {
          paths: [
            { name: "@/components/navigation/AppLayout", message: "Deprecated shell. Use PlatformShell from @/design-system." },
            { name: "@/components/navigation/AppAwareSidebar", message: "Deprecated sidebar. Use PlatformShell + per-workspace nav.ts." },
            { name: "@/components/navigation/AppTopNavbar", message: "Deprecated topbar. PlatformShell renders the unified WorkspaceTopBar." },
            { name: "@/components/navigation/AppNavbar", message: "Deprecated topbar. Use PlatformShell from @/design-system." },
            { name: "@/components/navigation/AppModuleTabs", message: "Horizontal module tabs are no longer the primary nav. Use per-workspace nav.ts groups." },
            { name: "@/components/navigation/ReportsSubNav", message: "Reports live under each workspace's nav.ts plus the cross-domain Reports workspace." },
            { name: "@/components/navigation/NavigationModeToggle", message: "Navigation mode is unified; the toggle is deprecated." },
          ],
          patterns: [
            { group: ["@/components/navigation"], message: "Import shell pieces from @/design-system (PlatformShell, primitives) instead of the legacy navigation barrel." },
          ],
        },
      ],
    },
  },

  // Legacy-shell allowlist: the modules below have not yet been migrated to
  // PlatformShell. They keep importing the deprecated nav components until
  // their workspace is migrated workspace-by-workspace. Remove entries here
  // as each module moves over — do not extend this list.
  {
    files: [
      "src/apps/reports/ReportsLayout.tsx",
      "src/components/navigation/**/*.{ts,tsx}",
    ],
    rules: {
      "no-restricted-imports": "off",
    },
  },
  // Localization-pack engine guard: payroll/statutory engines must not
  // branch on hard-coded rule_code literals (PAYE/NSSF/SHIF/AHL/NHIF/VAT…).
  // Use validated rule.parameters / computation_method dispatch instead.
  // See docs/adr/0010-localization-pack-versioning-and-tokens.md.
  {
    files: [
      "supabase/functions/compute-payroll/**/*.ts",
      "supabase/functions/generate-tax-certificate/**/*.ts",
      "supabase/functions/generate-statutory-return/**/*.ts",
      "supabase/functions/generate-localization-statutory-document/**/*.ts",
    ],
    rules: {
      "local/no-literal-rule-codes-in-engines": "error",
    },
  },
  // ADR 0060 — certificate paths must read YTD figures through
  // certificateSourceResolver, never by re-summing payslip_lines directly.
  {
    files: [
      "supabase/functions/generate-tax-certificate/**/*.ts",
      "supabase/functions/_shared/certificate*.ts",
    ],
    rules: {
      "local/no-payslip-lines-in-certificates": "error",
    },
  },
  // Platform Admin four-pattern rule (Phase 6) — forbid form-bearing
  // Dialog/Sheet under src/{pages,components}/admin/**. Real CRUD lives
  // on workspace routes; read-mostly quick looks on DocumentPeekShell;
  // confirmations on AlertDialog. See docs/design-system/audit/platform-admin.md.
  {
    files: [
      "src/pages/admin/**/*.{ts,tsx}",
      "src/components/admin/**/*.{ts,tsx}",
    ],
    rules: {
      "local/no-dialog-crud-in-admin": "error",
    },
  },

  // ESS Portal (Wave A/B) — every /me/* page must consume the design-system
  // PageHeader primitive. Editor-time flag; the arch test
  // `me-uses-design-system.test.ts` is the authoritative guard in CI.
  {
    files: ["src/pages/me/**/*.{ts,tsx}", "src/apps/me/**/*.{ts,tsx}"],
    rules: {
      "local/no-hand-rolled-me-header": "error",
      "local/no-shell-leak-from-me": "error",
    },
  },
  // ADR 0063 — one renderer per localization artefact type. No pdf-lib
  // in localization preview/renderer code (returns and certificates
  // share the certificate-engine paged compile pipeline). No country-
  // prefixed fixtures in shared preview code (a Ghana publisher must
  // not see Kenya PINs).
  {
    files: [
      "src/features/localization/**/*.{ts,tsx}",
      "supabase/functions/_shared/certificate-engine/**/*.ts",
    ],
    rules: {
      "local/no-pdf-lib-in-localization-preview": "error",
    },
  },
  {
    files: [
      "src/features/localization/components/preview/**/*.{ts,tsx}",
      "src/features/localization/lib/preview/**/*.{ts,tsx}",
    ],
    rules: {
      "local/no-country-fixture-in-shared-preview": "error",
    },
  },
  // ADR-0085 — rendering ownership guards. pdf-lib is banned from the
  // app bundle (server-side _shared/pdf only); raw barcode libs
  // (bwip-js, qrcode) are banned from app code. qrcode.react remains
  // allowed for on-screen SVG.
  {
    files: ["src/**/*.{ts,tsx}"],
    rules: {
      "local/no-raw-pdf-lib-in-app": "error",
      "local/no-direct-barcode-lib": "error",
      // Milestone C.2 — xlsx WRITE APIs are server-only. Read APIs
      // (XLSX.read / sheet_to_json) stay legal for user-uploaded imports.
      "local/no-raw-xlsx-in-app": "error",
    },
  },
  // ADR-0084 / Phase 4 item 10 — ESC/POS command bytes may only be
  // constructed by the sanctioned emitter package
  // (supabase/functions/_shared/escpos) and the thermal driver
  // transport layers. Everywhere else must produce a Line[] AST and
  // let the emitter turn it into bytes.
  {
    files: [
      "src/**/*.{ts,tsx}",
      "supabase/functions/**/*.ts",
    ],
    rules: {
      "local/no-raw-escpos-bytes": "error",
    },
  },
);

