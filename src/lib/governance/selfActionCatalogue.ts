/**
 * Canonical catalogue of sensitive action keys governed by the
 * Self-Action Policy framework ("do not approve your own X").
 *
 * Scope: Smart Grow Empowerment finance operations only. Each entry declares
 * the entity type it operates on and how the "subject" user is derived, which
 * powers the state-driven Override dialog — admins pick an action, the dialog
 * knows which table to search for the target record, and the subject user is
 * either the actor themselves or read off the chosen entity.
 *
 * Lending-specific duty separation (assess vs approve vs disburse vs receipt)
 * is enforced by the Segregation of Duties engine over `mf_*` events, not here.
 */

export type SelfActionEntityType =
  | "payment"
  | "journal_entry"
  | "expense"
  | "bank_account";

/**
 * How the override's `subject_user_id` is resolved.
 *  - `actor`        → subject == actor (plain self-approval)
 *  - `from_entity`  → subject is read off the picked entity row (e.g. expense.employee_id → employees.user_id)
 */
export type SubjectMode = "actor" | "from_entity";

export interface SelfActionEntry {
  key: string;
  module: "Finance" | "Spend";
  label: string;
  description: string;
  entityType: SelfActionEntityType;
  subjectMode: SubjectMode;
}

export const SELF_ACTION_CATALOGUE: SelfActionEntry[] = [
  // Finance — institution cash movements
  {
    key: "payment.approve",
    module: "Finance",
    label: "Approve own payment",
    description: "Approve a payment the approver recorded.",
    entityType: "payment",
    subjectMode: "actor",
  },
  {
    key: "journal.post",
    module: "Finance",
    label: "Post own journal entry",
    description: "Post a journal entry the approver created.",
    entityType: "journal_entry",
    subjectMode: "actor",
  },
  // Spend — staff operating expenses
  {
    key: "expense.approve",
    module: "Spend",
    label: "Approve own expense",
    description: "Approve an expense the approver recorded.",
    entityType: "expense",
    subjectMode: "actor",
  },
  {
    key: "expense.approve_self_benefit",
    module: "Spend",
    label: "Approve expense for own staff record",
    description: "Approve an expense whose staff member is the approver.",
    entityType: "expense",
    subjectMode: "from_entity",
  },
  // Finance — sensitive field changes
  {
    key: "bank_account.sensitive_change",
    module: "Finance",
    label: "Change bank account routing fields",
    description:
      "Modify the account number or routing number of an institution bank account. Silent changes can reroute disbursements and payments.",
    entityType: "bank_account",
    subjectMode: "actor",
  },
];

export const SELF_ACTION_MODES = [
  {
    value: "block" as const,
    label: "Block",
    description: "Refuse self-approval. A different approver must act.",
  },
  {
    value: "require_cosign" as const,
    label: "Require co-signed override",
    description: "Block unless an owner has issued a one-time override.",
  },
  {
    value: "warn" as const,
    label: "Warn",
    description: "Allow but log a security event for review.",
  },
  {
    value: "allow" as const,
    label: "Allow",
    description: "Permit self-approval without restriction.",
  },
];

export type SelfActionMode = (typeof SELF_ACTION_MODES)[number]["value"];

/** Human label for an entity type — used in picker placeholders and hints. */
export const ENTITY_TYPE_LABELS: Record<SelfActionEntityType, string> = {
  payment: "payment",
  journal_entry: "journal entry",
  expense: "expense",
  bank_account: "bank account",
};

/**
 * Wire-level entity_type value persisted to `self_action_overrides.entity_type`.
 * Matches the values the database triggers test against in `governance_assert_not_self`.
 */
export const ENTITY_TYPE_DB_KEY: Record<SelfActionEntityType, string> = {
  payment: "payment",
  journal_entry: "journal_entry",
  expense: "expense",
  bank_account: "bank_account",
};

/**
 * Reverse lookup — accepts the wire value that lands in
 * `audit_logs.entity_type` and returns the catalogue's entityType key.
 */
export const DB_KEY_TO_ENTITY_TYPE: Record<string, SelfActionEntityType> = Object.fromEntries(
  (Object.entries(ENTITY_TYPE_DB_KEY) as [SelfActionEntityType, string][]).map(
    ([k, v]) => [v, k],
  ),
) as Record<string, SelfActionEntityType>;
