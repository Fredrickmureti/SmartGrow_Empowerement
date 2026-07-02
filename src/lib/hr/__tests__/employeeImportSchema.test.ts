import { describe, it, expect } from "vitest";
import {
  composeEmployeeImportFields,
  splitImportedEmployeeRow,
} from "@/lib/hr/employeeImportSchema";
import { validateRow } from "@/lib/importUtils";

describe("composeEmployeeImportFields", () => {
  it("appends pack statutory + custom fields with prefixes after core fields", () => {
    const fields = composeEmployeeImportFields(
      [
        {
          requirement_key: "kra_pin",
          label: "KRA PIN",
          data_type: "text",
          is_required: true,
          is_active: true,
          validation_regex: "^[A-Z][0-9]{9}[A-Z]$",
          help_text: "Letter, 9 digits, letter",
          sort_order: 1,
          scope: "statutory_identifier",
        },
      ],
      [
        {
          field_key: "tshirt_size",
          field_label: "T-Shirt Size",
          field_type: "enum",
          is_required: false,
          is_visible: true,
          options: ["s", "m", "l"],
          display_order: 1,
          entity_type: "employee",
        },
      ],
    );

    const stat = fields.find((f) => f.key === "statutory.kra_pin")!;
    expect(stat).toBeDefined();
    expect(stat.required).toBe(true);
    expect(stat.pattern).toBe("^[A-Z][0-9]{9}[A-Z]$");
    expect(stat.helpText).toBe("Letter, 9 digits, letter");

    const custom = fields.find((f) => f.key === "custom.tshirt_size")!;
    expect(custom).toBeDefined();
    expect(custom.type).toBe("select");
    expect(custom.options).toEqual(["s", "m", "l"]);

    // Core fields appear before pack/custom
    const firstNameIdx = fields.findIndex((f) => f.key === "first_name");
    const statIdx = fields.findIndex((f) => f.key === "statutory.kra_pin");
    expect(firstNameIdx).toBeLessThan(statIdx);
  });

  it("skips inactive pack requirements and hidden custom fields", () => {
    const fields = composeEmployeeImportFields(
      [
        {
          requirement_key: "nssf_no",
          label: "NSSF",
          data_type: "text",
          is_required: false,
          is_active: false,
          validation_regex: null,
          help_text: null,
          sort_order: 1,
          scope: "statutory_identifier",
        },
      ],
      [
        {
          field_key: "secret",
          field_label: "Secret",
          field_type: "text",
          is_required: false,
          is_visible: false,
          options: null,
          display_order: 1,
          entity_type: "employee",
        },
      ],
    );
    expect(fields.find((f) => f.key === "statutory.nssf_no")).toBeUndefined();
    expect(fields.find((f) => f.key === "custom.secret")).toBeUndefined();
  });
});

describe("splitImportedEmployeeRow", () => {
  it("partitions core / statutory / custom fields and drops empties", () => {
    const out = splitImportedEmployeeRow({
      first_name: "Ada",
      last_name: "Lovelace",
      email: "  ",
      department: "Engineering",
      "statutory.kra_pin": "A123456789B",
      "statutory.nhif_no": "",
      "custom.tshirt_size": "m",
    });

    expect(out.core).toEqual({
      first_name: "Ada",
      last_name: "Lovelace",
      department: "Engineering",
    });
    expect(out.statutory).toEqual([
      { identifier_type: "kra_pin", identifier_value: "A123456789B" },
    ]);
    expect(out.customFields).toEqual([
      { field_key: "tshirt_size", field_value: "m" },
    ]);
  });
});

describe("validateRow regex enforcement", () => {
  const fields = composeEmployeeImportFields(
    [
      {
        requirement_key: "kra_pin",
        label: "KRA PIN",
        data_type: "text",
        is_required: true,
        is_active: true,
        validation_regex: "^[A-Z][0-9]{9}[A-Z]$",
        help_text: "Format: A123456789Z",
        sort_order: 1,
        scope: "statutory_identifier",
      },
    ],
    [],
  );

  it("rejects values that fail the pack-provided regex", () => {
    const errs = validateRow(
      { "KRA PIN": "not-a-pin", "First Name": "Ada", "Last Name": "Lovelace", "Hire Date": "2024-01-01" },
      fields,
      { "KRA PIN": "statutory.kra_pin", "First Name": "first_name", "Last Name": "last_name", "Hire Date": "hire_date" },
    );
    expect(errs.some((e) => e.field === "statutory.kra_pin")).toBe(true);
  });

  it("accepts values matching the regex", () => {
    const errs = validateRow(
      { "KRA PIN": "A123456789B", "First Name": "Ada", "Last Name": "Lovelace", "Hire Date": "2024-01-01" },
      fields,
      { "KRA PIN": "statutory.kra_pin", "First Name": "first_name", "Last Name": "last_name", "Hire Date": "hire_date" },
    );
    expect(errs.find((e) => e.field === "statutory.kra_pin")).toBeUndefined();
  });
});
