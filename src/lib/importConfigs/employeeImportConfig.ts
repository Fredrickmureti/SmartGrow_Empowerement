import { FieldDefinition } from "@/lib/importUtils";

/**
 * Canonical employee field definitions for CSV/XLSX import.
 * Used by the Employees page import.
 *
 * DO NOT duplicate this. If you need employee import anywhere,
 * import from this file.
 */
export const EMPLOYEE_IMPORT_FIELDS: FieldDefinition[] = [
  { key: "first_name", label: "First Name", required: true, type: "text", aliases: ["Given Name"] },
  { key: "last_name", label: "Last Name", required: true, type: "text", aliases: ["Surname", "Family Name"] },
  { key: "email", label: "Email", required: false, type: "email", aliases: ["E-mail"] },
  { key: "phone", label: "Phone", required: false, type: "text", aliases: ["Phone Number"] },
  { key: "hire_date", label: "Hire Date", required: true, type: "date", aliases: ["Start Date", "Join Date"] },
  { key: "department", label: "Department", required: false, type: "text", aliases: ["Dept", "Department Name"] },
  { key: "position", label: "Position", required: false, type: "text", aliases: ["Job Title", "Title", "Role"] },
  { key: "work_location", label: "Work Location", required: false, type: "text", aliases: ["Location", "Office"] },
  { key: "manager_email", label: "Manager Email", required: false, type: "email", aliases: ["Manager", "Reports To Email"] },
  // basic_salary intentionally removed — compensation lives on employee_contracts. Import contracts separately.
  { key: "national_id", label: "National ID", required: false, type: "text", aliases: ["ID Number"] },
  { key: "bank_account_number", label: "Bank Account", required: false, type: "text", aliases: ["Account Number"] },
];
