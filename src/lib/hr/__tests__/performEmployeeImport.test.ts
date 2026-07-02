import { describe, it, expect, vi } from "vitest";
import { performEmployeeImport } from "@/lib/hr/performEmployeeImport";

/**
 * Lightweight chainable Supabase mock that records writes by table.
 * Supports: from().select().eq().in() (returns configured data) and
 * from().insert(rows) (records rows, returns { error: null } or configured error).
 */
function makeSupabase(opts: {
  configRows?: Array<{ id: string; field_key: string }>;
  insertErrors?: Partial<Record<string, { message: string }>>;
}) {
  const inserted: Record<string, any[]> = {};
  const api = {
    from(table: string) {
      const chain: any = {
        select: () => chain,
        eq: () => chain,
        in: () => chain,
        or: () => chain,
        then: undefined,
      };
      // For entity_field_configs select, return configured config rows.
      if (table === "entity_field_configs") {
        // Make the chain itself awaitable: implement Thenable.
        chain.then = (resolve: any) => resolve({ data: opts.configRows ?? [], error: null });
      }
      chain.insert = (rows: any[]) => {
        inserted[table] = (inserted[table] ?? []).concat(rows);
        const err = opts.insertErrors?.[table] ?? null;
        return Promise.resolve({ error: err, data: rows });
      };
      return chain;
    },
    inserted,
  };
  return api;
}

const noopResolver = vi.fn(async () => ({
  department_id: "dept-1",
  job_position_id: "pos-1",
  work_location_id: null,
  manager_id: "mgr-1",
  warnings: ["Work location \"HQ\" not found — left blank."],
}));

describe("performEmployeeImport", () => {
  it("creates the employee, writes statutory + custom fields, and surfaces resolver warnings", async () => {
    const sb = makeSupabase({
      configRows: [{ id: "cfg-1", field_key: "tshirt_size" }],
    });
    const createEmployee = vi.fn(async (_payload: any) => ({ id: "emp-1" }));

    const result = await performEmployeeImport(
      {
        first_name: "Ada",
        last_name: "Lovelace",
        hire_date: "2024-01-01",
        department: "Engineering",
        position: "Engineer",
        work_location: "HQ",
        manager_email: "boss@example.com",
        "statutory.kra_pin": "A123456789B",
        "custom.tshirt_size": "m",
      },
      {
        supabase: sb as any,
        createEmployee,
        organizationId: "org-1",
        businessId: "biz-1",
        resolveNaturalKeys: noopResolver as any,
      },
    );

    expect(result.employeeId).toBe("emp-1");
    expect(result.warnings).toContain("Work location \"HQ\" not found — left blank.");

    // createEmployee called with resolved FK IDs and core fields, WITHOUT
    // the natural-key columns.
    expect(createEmployee).toHaveBeenCalledTimes(1);
    const payload = createEmployee.mock.calls[0][0] as any;
    expect(payload.first_name).toBe("Ada");
    expect(payload.department_id).toBe("dept-1");
    expect(payload.job_position_id).toBe("pos-1");
    expect(payload.manager_id).toBe("mgr-1");
    expect(payload.work_location_id).toBeNull();
    expect(payload.department).toBeUndefined();
    expect(payload.manager_email).toBeUndefined();

    // Statutory identifier insert.
    expect(sb.inserted["employee_statutory_identifiers"]).toEqual([
      {
        employee_id: "emp-1",
        organization_id: "org-1",
        business_id: "biz-1",
        identifier_type: "kra_pin",
        identifier_value: "A123456789B",
        is_active: true,
      },
    ]);

    // Custom field value insert, with resolved field_config_id.
    expect(sb.inserted["entity_field_values"]).toEqual([
      {
        entity_type: "employee",
        entity_id: "emp-1",
        organization_id: "org-1",
        business_id: "biz-1",
        field_config_id: "cfg-1",
        field_key: "tshirt_size",
        field_value: "m",
      },
    ]);
  });

  it("warns when a custom field has no matching entity_field_configs row", async () => {
    const sb = makeSupabase({ configRows: [] });
    const createEmployee = vi.fn(async () => ({ id: "emp-2" }));

    const result = await performEmployeeImport(
      {
        first_name: "Grace", last_name: "Hopper", hire_date: "2024-01-01",
        "custom.unknown_field": "x",
      },
      {
        supabase: sb as any,
        createEmployee,
        organizationId: "org-1",
        resolveNaturalKeys: (async () => ({
          department_id: null, job_position_id: null, work_location_id: null, manager_id: null, warnings: [],
        })) as any,
      },
    );

    expect(result.warnings.some((w) => w.includes("unknown_field"))).toBe(true);
    expect(sb.inserted["entity_field_values"]).toBeUndefined();
  });

  it("stops short and returns null employeeId when createEmployee returns nothing", async () => {
    const sb = makeSupabase({});
    const createEmployee = vi.fn(async () => null);

    const result = await performEmployeeImport(
      { first_name: "Alan", last_name: "Turing", hire_date: "2024-01-01" },
      {
        supabase: sb as any,
        createEmployee,
        organizationId: "org-1",
        resolveNaturalKeys: (async () => ({
          department_id: null, job_position_id: null, work_location_id: null, manager_id: null, warnings: [],
        })) as any,
      },
    );

    expect(result.employeeId).toBeNull();
    expect(sb.inserted["employee_statutory_identifiers"]).toBeUndefined();
  });
});
