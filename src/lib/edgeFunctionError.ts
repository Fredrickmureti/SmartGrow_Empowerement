/**
 * Helpers for extracting human-friendly error messages from Supabase
 * Edge Function failures.
 *
 * Supabase's `.functions.invoke()` returns a `FunctionsHttpError` whose
 * `.context` is the underlying `Response`. Without reading that body, the
 * UI only ever sees "Edge Function returned a non-2xx code" — which hides
 * the structured `{ error, code }` payload our edge functions return.
 *
 * This util attempts to read the response body and extract:
 *   - `error`: the human-readable message
 *   - `code`:  the machine-readable failure category (e.g. PERMISSION_DENIED)
 *
 * Falls back gracefully if the response body has already been consumed or
 * is not JSON.
 */

export interface ParsedEdgeError {
  message: string;
  code?: string;
  status?: number;
  /** Full JSON body of the edge function error response, if it was JSON. */
  body?: any;
}

const PERMISSION_DENIED_HINT =
  "You don't have permission for this action. Ask an organization owner or administrator to grant your Access Group the required permission, or to perform the action for you.";

// Hints keyed by the Postgres `HINT` string our RPCs raise alongside
// ERRCODE 42501. Lets us distinguish a real permission gap (operator lacks
// a granted right) from an internal identity-loss bug (request reached the
// server without a verified caller). The previous blanket message told
// organization owners to demote themselves to a "Payroll Admin" access
// group that doesn't exist — actively harmful for governance authorities.
const HINT_MESSAGES: Record<string, string> = {
  IDENTITY_REQUIRED:
    "Internal authorization error: the request reached the server without a verified identity. Please sign out and sign back in. If this persists, contact support.",
  PAYROLL_REVERSE_FORBIDDEN:
    "You don't have permission to reverse payroll runs. Ask an organization owner or administrator to grant you the Payroll → Reverse permission, or to perform the reversal for you.",
  FINANCE_VOID_JE_FORBIDDEN:
    "You don't have permission to void journal entries for this business. Ask an organization owner or administrator to grant you the Finance → Void Journal Entry permission.",
  FINANCE_MANAGE_JE_FORBIDDEN:
    "You don't have permission to manage journal entries for this business. Ask an organization owner or administrator to grant you the Finance → Manage Journal Entry permission.",
  // Payroll integrity gates — raised by approve_payroll_run when a loan or
  // salary-advance installment due in the pay period was not represented as
  // a payslip line and no skip override exists. Operator must either fix
  // the missing deduction OR record an explicit skip override.
  PAYROLL_LOAN_INSTALLMENT_MISSING:
    "A scheduled loan installment that falls inside this pay period was not deducted on any payslip. Add the deduction to the affected payslips, or record an audited skip override before approving the run.",
  PAYROLL_ADVANCE_INSTALLMENT_MISSING:
    "A scheduled salary-advance installment that falls inside this pay period was not deducted on any payslip. Add the deduction to the affected payslips, or record an audited skip override before approving the run.",
  // Wave 3.5 — reopen guard. Block adding a new payslip for an archived
  // employee onto a non-terminal payroll run.
  PAYROLL_EMPLOYEE_ARCHIVED:
    "This employee has been archived. New payslips can no longer be added for them on open payroll runs. Re-activate the employee first if this addition is intentional.",
  // Turn D — benefits open-enrollment guard
  BENEFIT_ENROLLMENT_WINDOW_LOCKED:
    "This benefits open-enrollment window has been locked by an administrator. No further elections can be saved against it.",
  BENEFIT_ENROLLMENT_WINDOW_CLOSED:
    "This benefits open-enrollment window is not currently open. Elections can only be saved between its open and close dates.",
  BENEFIT_ENROLLMENT_WINDOW_MISSING:
    "The benefits open-enrollment window referenced no longer exists. Refresh and try again.",
};

const CODE_HINTS: Record<string, string> = {
  PERMISSION_DENIED: PERMISSION_DENIED_HINT,
  APP_NOT_IN_PLAN:
    "This app is not included in your current plan. Ask an admin to upgrade the subscription plan.",
  FEATURE_NOT_IN_PLAN:
    "This feature is not included in your current plan. Ask an admin to upgrade the subscription plan.",
  APP_NOT_INSTALLED:
    "This app is not installed for your organization. An admin can install it from the Apps page.",
  SUBSCRIPTION_INACTIVE:
    "Your organization's subscription is not active. Renew or reactivate the subscription to continue.",
  ORG_SUSPENDED:
    "Your organization is currently suspended. Contact support to restore access.",
};

// Append Turn E + immutability + SoD + exit-clearance hints to HINT_MESSAGES.
// Done as Object.assign so the original `const` block stays unchanged.
Object.assign(HINT_MESSAGES, {
  ROSTER_ASSIGNMENT_OVERLAP:
    "This employee already has another shift that overlaps these hours. Cancel the conflicting assignment first, or pick a different shift.",
  ROSTER_SWAP_APPROVER_CONFLICT:
    "The approver of a shift swap cannot be the requester or the target employee. Ask a different manager to decide on this swap.",
  PAYROLL_RUN_IMMUTABLE:
    "This payroll run has been posted, paid, or reversed and its financial totals are locked. Reverse the run first to make corrections.",
  PAYSLIP_IMMUTABLE:
    "This payslip belongs to a posted, paid, or reversed payroll run and can no longer be edited. Reverse the run first to amend it.",
  PAYSLIP_LINE_IMMUTABLE:
    "Payslip lines on posted, paid, or reversed payroll runs cannot be changed. Reverse the run first to amend it.",
  PAYROLL_POST_SOD_VIOLATION:
    "Segregation of duties: the user posting payroll to the General Ledger must be different from the run's creator and approver. Ask another finance user with posting rights to post this run.",
  PAYROLL_PAY_SOD_VIOLATION:
    "Segregation of duties: the user marking a payroll run paid must be different from its creator, approver, and poster. Ask another authorised payer to release the disbursement.",
  PAYROLL_MAKER_CHECKER_VIOLATION:
    "Maker–checker policy: the user approving this payroll run cannot also be its creator. Ask another authorised approver, or update the workspace self-approval policy.",
  EXIT_CLEARANCE_UNSETTLED_LOANS:
    "This employee still has active or suspended loans with an outstanding balance. Settle or write off the loans before completing exit clearance.",
  PAYROLL_NO_LOCALIZATION_PACK:
    "No active fiscal localization pack is installed for this workspace. Install or publish a country-specific pack before running payroll.",
  RECRUITMENT_APP_NOT_FOUND:
    "The application could not be found. It may have been deleted.",
  RECRUITMENT_FORBIDDEN:
    "You don't have permission to convert applications into employees.",
  RECRUITMENT_STAGE_INVALID:
    "Move the application to the offer or hired stage before converting it to an employee.",

  // ---- Employee loans -------------------------------------------------
  LOAN_POLICY_MIN_INSTALLMENTS: "The minimum number of installments must be at least 1.",
  LOAN_POLICY_MAX_INSTALLMENTS: "The maximum number of installments must be at least 1.",
  LOAN_POLICY_INSTALLMENT_RANGE:
    "The minimum number of installments cannot be greater than the maximum.",
  LOAN_POLICY_MIN_PRINCIPAL: "The minimum loan amount cannot be negative.",
  LOAN_POLICY_MAX_PRINCIPAL: "The maximum loan amount cannot be negative.",
  LOAN_POLICY_PRINCIPAL_RANGE:
    "The minimum loan amount cannot be greater than the maximum loan amount.",
  LOAN_POLICY_MIN_TENURE: "The minimum loan term must be at least 1 month.",
  LOAN_POLICY_MAX_TENURE: "The maximum loan term must be at least 1 month.",
  LOAN_POLICY_TENURE_RANGE: "The minimum loan term cannot be longer than the maximum term.",
  LOAN_POLICY_MAX_PCT_OF_NET:
    "The maximum deduction percentage of net pay must be between 0 and 100.",
  LOAN_POLICY_NET_PAY_FLOOR: "The minimum take-home pay floor cannot be negative.",
  LOAN_POLICY_DEDUCTION_PRIORITY: "The deduction priority must be between 1 and 10000.",
  LOAN_POLICY_SALARY_RULE_CODE:
    "The salary rule code must be lowercase letters, numbers and underscores only, starting with a letter.",
  LOAN_POLICY_MAX_SKIPS_PER_LOAN: "The number of allowed skips per loan cannot be negative.",
  LOAN_POLICY_MAX_SKIPS_PER_YEAR: "The number of allowed skips per year cannot be negative.",
  LOAN_POLICY_SKIP_GAP: "The minimum gap between skipped repayments cannot be negative.",
  LOAN_POLICY_REPAYMENT_METHOD: "Choose a valid repayment method for this loan product.",
  LOAN_POLICY_INTEREST_METHOD: "Choose a valid interest method for this loan product.",
  LOAN_POLICY_SKIP_INTEREST:
    "Choose how interest is treated when a repayment is skipped (accrue, waive, or capitalise).",
  LOAN_POLICY_SKIP_SCHEDULE:
    "Choose how the schedule adjusts when a repayment is skipped (push end, rebalance, or shorten).",
});


const OFFLINE_MESSAGE =
  "It looks like your internet connection dropped while running payroll, so we couldn't reach the server. No changes were saved — reconnect and run it again. If the connection is stable and this keeps happening, contact support.";

// Distinct from OFFLINE: the browser is online but the request to the edge
// runtime failed (edge-runtime CPU/wall-time kill, response too large, or
// upstream drop). We MUST NOT tell the user "no changes were saved" —
// compute-payroll may have already committed partial state. The UI should
// refetch the run and let the user decide.
const TRANSPORT_FAILED_MESSAGE =
  "The payroll engine did not respond in time. Your payroll may still be running on the server — refresh this page and check the run's status before retrying. Retrying blindly can create duplicate payslips.";

/**
 * Detect a transport-level failure (the request never reached the edge
 * function) versus a structured edge-function error. Supabase surfaces an
 * internet drop as `FunctionsFetchError` ("Failed to send a request to the
 * Edge Function") or a raw `TypeError: Failed to fetch` — neither carries a
 * `.context` Response. We must NOT show those raw strings to users.
 */
function classifyTransport(error: unknown): "offline" | "transport" | null {
  const name = (error as { name?: string })?.name ?? "";
  const msg = ((error as { message?: string })?.message ?? "").toLowerCase();
  const isFetchShape =
    name === "FunctionsFetchError" ||
    name === "AbortError" ||
    name === "TimeoutError" ||
    msg.includes("failed to send a request") ||
    msg.includes("failed to fetch") ||
    msg.includes("load failed") ||
    msg.includes("networkerror") ||
    msg.includes("network error");
  if (!isFetchShape) return null;
  // Only claim OFFLINE when the browser itself says so. Everything else is
  // a server-reachability failure, not a dropped internet connection.
  if (typeof navigator !== "undefined" && navigator.onLine === false) return "offline";
  return "transport";
}

export async function parseEdgeFunctionError(error: unknown): Promise<ParsedEdgeError> {
  if (!error) return { message: "Unknown error" };

  // Transport-layer failure — the request never reached the server, OR the
  // edge runtime dropped the connection mid-invoke. We split these so the UI
  // can react correctly: OFFLINE => "no changes were saved", TRANSPORT_FAILED
  // => "may still be running, refresh before retrying".
  const transport = classifyTransport(error);
  if (transport === "offline") return { message: OFFLINE_MESSAGE, code: "OFFLINE" };
  if (transport === "transport") return { message: TRANSPORT_FAILED_MESSAGE, code: "TRANSPORT_FAILED" };

  // FunctionsHttpError surfaces the original Response on `.context`.
  const ctx = (error as { context?: Response }).context;
  if (ctx && typeof ctx.json === "function") {
    try {
      // Clone so callers can read the body again if needed.
      const cloned = typeof ctx.clone === "function" ? ctx.clone() : ctx;
      const body = await cloned.json();
      const code = body?.code as string | undefined;
      const rawHint = (body?.hint as string | undefined) ?? "";
      const hintKey = rawHint.toUpperCase();
      let message = (body?.error as string | undefined) ??
                    (body?.message as string | undefined) ??
                    `Request failed (${ctx.status})`;

      // Prefer a hint-specific message (more accurate) over the generic
      // code-level fallback. This is how PAYROLL_REVERSE_FORBIDDEN and
      // IDENTITY_REQUIRED produce different copy under one code.
      const hintMessage = hintKey ? HINT_MESSAGES[hintKey] : undefined;
      const codeMessage = code ? CODE_HINTS[code] : undefined;
      const hint = hintMessage ?? codeMessage;
      if (hint) {
        message = `${message}\n\n${hint}`;
      }

      return { message, code, status: ctx.status, body };
    } catch {
      // Body wasn't JSON or already consumed — fall through.
    }
  }

  const fallback =
    (error as { message?: string }).message ??
    (typeof error === "string" ? error : "Edge function call failed");
  return { message: fallback };
}
