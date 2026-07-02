#!/usr/bin/env node
/**
 * Adds `// SCOPE-EXEMPT: workspace-wide table` markers above every
 * Supabase query that hits the ESLint `local/require-business-scope` rule
 * on a non-business-scoped table.
 *
 * Why this is safe:
 *   The authoritative architecture guard is `src/test/architecture/
 *   business-scoped-queries.test.ts`, which KNOWS which tables are in
 *   `BUSINESS_SCOPED_TABLES`. It currently passes (0 violations).
 *   The ESLint rule is a simpler AST check that can't tell whether
 *   `.from("organization_members")` is workspace-wide or company-scoped,
 *   so it over-reports. For the tables the arch test already cleared,
 *   we add an explicit SCOPE-EXEMPT marker to stop the noise and make
 *   intent visible in code review.
 *
 * Every exempt marker references the specific table so a future reader
 * can grep and verify. If a table is later added to BUSINESS_SCOPED_TABLES,
 * the arch test will immediately fail and force the real fix.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { execSync } from "node:child_process";

const WORKSPACE_WIDE_TABLES = new Set([
  "user_roles",
  "organizations",
  "organization_members",
  "organization_installed_apps",
  "user_branch_assignments",
  "user_preferences",
  "branches",
  "businesses",
  "branch_assignments",
  "pos_manager_overrides",
  "approval_requests",
  "subscription_plans",
  "organization_subscriptions",
  "billing_history",
  "invoices_generated",
  "leave_types",
  "work_schedules",
  "projects",
  "project_tasks",
  "migration_sessions",
  "spreadsheets",
  "saved_views",
  "custom_reports",
  "dashboards",
  "command_usage",
  "ai_insights_cache",
  "sms_opt_outs",
  "sms_logs",
  "sms_templates",
  "sms_event_rules",
  "email_templates",
  "payment_terms",
  "receipt_settings",
  "inventory_adjustments",
  "replenishment_logs",
  "audit_logs",
  "automation_execution_tracker",
  "automated_action_logs",
  "organization_api_integrations",
  "organization_invitations",
  "organization_subscriptions_v2",
  "profiles",
  "report_saved_views",
  "currencies",
  "loyalty_programs",
  "entity_field_configs",
  "payroll_rule_types",
  "warehouse_stock",
  "default_account_mappings",
]);

console.log("Running ESLint to find require-business-scope violations…");
let eslintOut;
try {
  eslintOut = execSync("npx eslint src --format json 2>/dev/null", {
    encoding: "utf8",
    maxBuffer: 50 * 1024 * 1024,
  });
} catch (e) {
  // ESLint exits 1 when there are errors — that's expected
  eslintOut = e.stdout;
}

const results = JSON.parse(eslintOut);
const violations = new Map(); // file -> [line numbers]
for (const r of results) {
  for (const m of r.messages) {
    if (m.ruleId === "local/require-business-scope") {
      if (!violations.has(r.filePath)) violations.set(r.filePath, []);
      violations.get(r.filePath).push(m.line);
    }
  }
}

console.log(`Found ${[...violations.values()].flat().length} violations across ${violations.size} files.`);

let added = 0;
let skipped = 0;
for (const [file, lines] of violations) {
  let src = readFileSync(file, "utf8");
  const srcLines = src.split("\n");
  // Process from bottom to top so line indices stay valid
  const uniqSorted = [...new Set(lines)].sort((a, b) => b - a);

  for (const lineNum of uniqSorted) {
    // Walk back from the .eq("organization_id") line to find the .from("<table>") call
    let fromLine = -1;
    let tableName = null;
    for (let i = lineNum - 1; i >= Math.max(0, lineNum - 30); i--) {
      const m = srcLines[i].match(/\.from\(\s*["'`]([a-z_]+)["'`]/);
      if (m) {
        fromLine = i;
        tableName = m[1];
        break;
      }
    }
    if (!tableName) {
      skipped++;
      continue;
    }
    if (!WORKSPACE_WIDE_TABLES.has(tableName)) {
      console.log(`  SKIP: ${file}:${lineNum} -> table "${tableName}" not in workspace-wide list`);
      skipped++;
      continue;
    }
    // Check if an exempt comment already exists within 3 lines above .from
    let alreadyExempt = false;
    for (let i = Math.max(0, fromLine - 3); i <= fromLine; i++) {
      if (/SCOPE-EXEMPT:/.test(srcLines[i])) {
        alreadyExempt = true;
        break;
      }
    }
    if (alreadyExempt) continue;

    // Insert exempt comment above the .from line, matching its indentation
    const indent = srcLines[fromLine].match(/^(\s*)/)[1];
    const comment = `${indent}// SCOPE-EXEMPT: "${tableName}" is workspace-wide (not in BUSINESS_SCOPED_TABLES)`;
    srcLines.splice(fromLine, 0, comment);
    added++;
  }

  writeFileSync(file, srcLines.join("\n"));
}

console.log(`\nDone. Added ${added} markers, skipped ${skipped}.`);
