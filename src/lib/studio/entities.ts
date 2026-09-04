/**
 * Studio entity catalogue — microfinance domain.
 *
 * Single source of truth for the entities Studio can customize: the type
 * union, display labels, rail grouping, and the built-in ("core") field
 * catalogue used by the field manager, view builder, and report field
 * selector. Do not fork these lists inside a component.
 */

export type EntityType =
  | "mf_client"
  | "mf_group"
  | "mf_loan_application"
  | "mf_loan"
  | "mf_disbursement"
  | "mf_repayment"
  | "mf_collection_activity"
  | "mf_loan_product"
  | "employee"
  | "expense";

export const ENTITY_TYPE_LABELS: Record<EntityType, string> = {
  mf_client: "Clients",
  mf_group: "Groups",
  mf_loan_application: "Loan Applications",
  mf_loan: "Loans",
  mf_disbursement: "Disbursements",
  mf_repayment: "Repayments",
  mf_collection_activity: "Collection Activities",
  mf_loan_product: "Loan Products",
  employee: "Staff",
  expense: "Expenses",
};

export interface CoreFieldDef {
  field: string;
  label: string;
  protected?: boolean;
}

export const CORE_FIELDS: Record<EntityType, CoreFieldDef[]> = {
  mf_client: [
    { field: "client_number", label: "Client #", protected: true },
    { field: "full_name", label: "Full Name", protected: true },
    { field: "national_id", label: "National ID", protected: true },
    { field: "phone", label: "Phone" },
    { field: "gender", label: "Gender" },
    { field: "date_of_birth", label: "Date of Birth" },
    { field: "branch_name", label: "Branch", protected: true },
    { field: "loan_officer", label: "Loan Officer" },
    { field: "status", label: "Status", protected: true },
    { field: "business_activity", label: "Business Activity" },
    { field: "created_at", label: "Registered On" },
  ],
  mf_group: [
    { field: "group_number", label: "Group #", protected: true },
    { field: "name", label: "Group Name", protected: true },
    { field: "branch_name", label: "Branch", protected: true },
    { field: "loan_officer", label: "Loan Officer" },
    { field: "meeting_day", label: "Meeting Day" },
    { field: "meeting_time", label: "Meeting Time" },
    { field: "meeting_place", label: "Meeting Place" },
    { field: "member_count", label: "Members" },
    { field: "status", label: "Status", protected: true },
  ],
  mf_loan_application: [
    { field: "application_number", label: "Application #", protected: true },
    { field: "client_name", label: "Client", protected: true },
    { field: "loan_product", label: "Loan Product", protected: true },
    { field: "requested_amount", label: "Requested Amount", protected: true },
    { field: "cycle_number", label: "Loan Cycle" },
    { field: "status", label: "Stage", protected: true },
    { field: "loan_officer", label: "Loan Officer" },
    { field: "applied_on", label: "Applied On" },
    { field: "notes", label: "Notes" },
  ],
  mf_loan: [
    { field: "loan_number", label: "Loan #", protected: true },
    { field: "client_name", label: "Client", protected: true },
    { field: "loan_product", label: "Loan Product", protected: true },
    { field: "principal_amount", label: "Principal", protected: true },
    { field: "interest_rate", label: "Interest Rate", protected: true },
    { field: "outstanding_balance", label: "Outstanding", protected: true },
    { field: "status", label: "Status", protected: true },
    { field: "disbursed_on", label: "Disbursed On" },
    { field: "next_due_date", label: "Next Due Date" },
    { field: "days_in_arrears", label: "Days in Arrears" },
  ],
  mf_disbursement: [
    { field: "loan_number", label: "Loan #", protected: true },
    { field: "client_name", label: "Client", protected: true },
    { field: "amount", label: "Amount", protected: true },
    { field: "method", label: "Method", protected: true },
    { field: "disbursed_on", label: "Disbursed On" },
    { field: "disbursed_by", label: "Disbursed By" },
    { field: "reference", label: "Reference" },
  ],
  mf_repayment: [
    { field: "receipt_number", label: "Receipt #", protected: true },
    { field: "loan_number", label: "Loan #", protected: true },
    { field: "client_name", label: "Client", protected: true },
    { field: "amount", label: "Amount", protected: true },
    { field: "payment_method", label: "Payment Method", protected: true },
    { field: "collected_on", label: "Collected On" },
    { field: "collected_by", label: "Collected By" },
    { field: "notes", label: "Notes" },
  ],
  mf_collection_activity: [
    { field: "loan_number", label: "Loan #", protected: true },
    { field: "client_name", label: "Client", protected: true },
    { field: "activity_type", label: "Activity Type", protected: true },
    { field: "activity_date", label: "Activity Date" },
    { field: "promised_amount", label: "Promised Amount" },
    { field: "promised_date", label: "Promised Date" },
    { field: "outcome", label: "Outcome" },
    { field: "loan_officer", label: "Officer" },
    { field: "notes", label: "Notes" },
  ],
  mf_loan_product: [
    { field: "name", label: "Product Name", protected: true },
    { field: "code", label: "Code", protected: true },
    { field: "interest_method", label: "Interest Method", protected: true },
    { field: "interest_rate", label: "Interest Rate", protected: true },
    { field: "min_principal", label: "Minimum Principal" },
    { field: "max_principal", label: "Maximum Principal" },
    { field: "term_installments", label: "Term (installments)" },
    { field: "status", label: "Status", protected: true },
  ],
  employee: [
    { field: "name", label: "Name", protected: true },
    { field: "email", label: "Email" },
    { field: "phone", label: "Phone" },
    { field: "branch_name", label: "Branch" },
    { field: "department", label: "Department" },
    { field: "position", label: "Role" },
    { field: "status", label: "Status", protected: true },
    { field: "hire_date", label: "Hire Date" },
  ],
  expense: [
    { field: "description", label: "Description", protected: true },
    { field: "amount", label: "Amount", protected: true },
    { field: "category", label: "Category" },
    { field: "status", label: "Status", protected: true },
    { field: "expense_date", label: "Date" },
    { field: "branch_name", label: "Branch" },
    { field: "notes", label: "Notes" },
  ],
};

/** Entities whose amounts post to the ledger — customization is metadata only. */
export const FINANCIAL_ENTITY_TYPES = new Set<EntityType>([
  "mf_loan",
  "mf_disbursement",
  "mf_repayment",
  "expense",
]);

/** Entities with a printable document template. */
export const DOCUMENT_ENTITY_TYPES = new Set<EntityType>([
  "mf_loan_application",
  "mf_loan",
  "mf_disbursement",
  "mf_repayment",
]);

/** Entities that can be included in scheduled/ad-hoc report field selection. */
export const REPORTABLE_ENTITIES: EntityType[] = [
  "mf_client",
  "mf_group",
  "mf_loan_application",
  "mf_loan",
  "mf_repayment",
  "mf_collection_activity",
];

export interface EntityGroup {
  label: string;
  entities: EntityType[];
}

export const ENTITY_GROUPS: EntityGroup[] = [
  { label: "Clients", entities: ["mf_client", "mf_group"] },
  {
    label: "Lending",
    entities: [
      "mf_loan_application",
      "mf_loan",
      "mf_disbursement",
      "mf_repayment",
    ],
  },
  { label: "Collections", entities: ["mf_collection_activity"] },
  {
    label: "Administration",
    entities: ["mf_loan_product", "employee", "expense"],
  },
];
