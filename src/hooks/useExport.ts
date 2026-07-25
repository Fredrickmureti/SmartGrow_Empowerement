import { useCallback } from "react";
import { rolesFromContact } from "@/lib/contactRoles";
import { downloadCsv, csvBlob } from "@/lib/exports/csv";


interface ExportOptions {
  filename: string;
  headers?: string[];
}

export function useExport() {
  const exportToCSV = useCallback(
    <T extends Record<string, any>>(data: T[], options: ExportOptions) => {
      if (data.length === 0) {
        throw new Error("No data to export");
      }

      const headers = options.headers || Object.keys(data[0]);

      // Build CSV content
      const csvRows: string[] = [];

      // Add header row
      csvRows.push(headers.map(escapeCSVValue).join(","));

      // Add data rows
      for (const row of data) {
        const values = headers.map((header) => {
          const value = row[header];
          return escapeCSVValue(formatValue(value));
        });
        csvRows.push(values.join(","));
      }

      // Route through the canonical CSV writer so we get UTF-8 BOM +
      // CRLF + a `text/csv;charset=utf-8` Blob (Excel-safe).
      downloadCsv(`${options.filename}.csv`, csvRows.join("\r\n"));
    },
    []
  );

  const exportToJSON = useCallback(
    <T extends Record<string, any>>(data: T[], options: ExportOptions) => {
      const jsonContent = JSON.stringify(data, null, 2);
      downloadFile(
        jsonContent,
        `${options.filename}.json`,
        "application/json"
      );
    },
    []
  );

  const exportInvoices = useCallback(
    (invoices: any[]) => {
      const data = invoices.map((inv) => ({
        invoice_number: inv.invoice_number,
        customer: inv.contact?.name || "",
        issue_date: inv.issue_date,
        due_date: inv.due_date,
        status: inv.status,
        subtotal: inv.subtotal,
        tax_amount: inv.tax_amount,
        total: inv.total,
        amount_paid: inv.amount_paid || 0,
        balance: inv.total - (inv.amount_paid || 0),
        currency: inv.currency,
      }));

      exportToCSV(data, {
        filename: `invoices_${new Date().toISOString().split("T")[0]}`,
        headers: [
          "invoice_number",
          "customer",
          "issue_date",
          "due_date",
          "status",
          "subtotal",
          "tax_amount",
          "total",
          "amount_paid",
          "balance",
          "currency",
        ],
      });
    },
    [exportToCSV]
  );

  const exportExpenses = useCallback(
    (expenses: any[]) => {
      const data = expenses.map((exp) => ({
        date: exp.expense_date,
        description: exp.description,
        category: exp.category?.name || "",
        vendor: exp.vendor?.name || "",
        amount: exp.amount,
        tax_amount: exp.tax_amount || 0,
        total: exp.amount + (exp.tax_amount || 0),
        status: exp.status,
        reference: exp.reference || "",
        is_billable: exp.is_billable ? "Yes" : "No",
        currency: exp.currency,
      }));

      exportToCSV(data, {
        filename: `expenses_${new Date().toISOString().split("T")[0]}`,
        headers: [
          "date",
          "description",
          "category",
          "supplier",
          "amount",
          "tax_amount",
          "total",
          "status",
          "reference",
          "is_billable",
          "currency",
        ],
      });
    },
    [exportToCSV]
  );

  const exportContacts = useCallback(
    (contacts: any[]) => {
      const data = contacts.map((c) => {
        const roles = rolesFromContact(c);
        // `parent:contacts!parent_contact_id(name)` is the canonical join used
        // across the contacts list queries. Fall back to a flat `parent_name`
        // if the caller pre-flattened the row.
        const parentName = c.parent?.name ?? c.parent_name ?? "";
        return {
          name: c.name,
          email: c.email || "",
          phone: c.phone || "",
          is_company: c.is_company ? "Yes" : "No",
          parent_company_name: parentName,
          child_address_type: c.child_address_type || "",
          is_customer: roles.isCustomer ? "Yes" : "No",
          is_supplier: roles.isSupplier ? "Yes" : "No",
          type: c.type || (roles.isCustomer && roles.isSupplier ? "both" : roles.isSupplier ? "supplier" : "customer"),
          address_line1: c.address_line1 || "",
          address_line2: c.address_line2 || "",
          city: c.city || "",
          state: c.state || "",
          postal_code: c.postal_code || "",
          country: c.country || "",
          tax_id: c.tax_id || "",
          credit_limit: c.credit_limit ?? "",
          notes: c.notes || "",
          is_active: c.is_active ? "Yes" : "No",
        };
      });

      exportToCSV(data, {
        filename: `contacts_${new Date().toISOString().split("T")[0]}`,
        headers: [
          "name",
          "email",
          "phone",
          "is_company",
          "parent_company_name",
          "child_address_type",
          "is_customer",
          "is_supplier",
          "type",
          "address_line1",
          "address_line2",
          "city",
          "state",
          "postal_code",
          "country",
          "tax_id",
          "credit_limit",
          "notes",
          "is_active",
        ],
      });
    },
    [exportToCSV]
  );

  const exportPayments = useCallback(
    (payments: any[]) => {
      const data = payments.map((p) => ({
        date: p.payment_date,
        invoice_number: p.invoice?.invoice_number || "",
        customer: p.contact?.name || "",
        amount: p.amount,
        payment_method: p.payment_method,
        reference: p.reference || "",
        notes: p.notes || "",
      }));

      exportToCSV(data, {
        filename: `payments_${new Date().toISOString().split("T")[0]}`,
        headers: [
          "date",
          "invoice_number",
          "customer",
          "amount",
          "payment_method",
          "reference",
          "notes",
        ],
      });
    },
    [exportToCSV]
  );

  const exportBills = useCallback(
    (bills: any[]) => {
      const data = bills.map((b) => ({
        bill_number: b.bill_number,
        vendor: b.vendor?.name || "",
        vendor_invoice: b.vendor_invoice_number || "",
        bill_date: b.bill_date,
        due_date: b.due_date,
        status: b.status,
        subtotal: b.subtotal,
        tax_amount: b.tax_amount,
        total: b.total,
        amount_paid: b.amount_paid || 0,
        balance: b.total - (b.amount_paid || 0),
        currency: b.currency,
      }));

      exportToCSV(data, {
        filename: `bills_${new Date().toISOString().split("T")[0]}`,
        headers: [
          "bill_number",
          "supplier",
          "vendor_invoice",
          "bill_date",
          "due_date",
          "status",
          "subtotal",
          "tax_amount",
          "total",
          "amount_paid",
          "balance",
          "currency",
        ],
      });
    },
    [exportToCSV]
  );

  const exportProducts = useCallback(
    (products: any[]) => {
      const data = products.map((p) => ({
        name: p.name,
        sku: p.sku || "",
        type: p.type,
        description: p.description || "",
        unit_price: p.unit_price,
        cost_price: p.cost_price || 0,
        tax_rate: p.tax_rate || 0,
        is_active: p.is_active ? "Yes" : "No",
      }));

      exportToCSV(data, {
        filename: `products_${new Date().toISOString().split("T")[0]}`,
        headers: [
          "name",
          "sku",
          "type",
          "description",
          "unit_price",
          "cost_price",
          "tax_rate",
          "is_active",
        ],
      });
    },
    [exportToCSV]
  );

  const exportRecurringInvoices = useCallback(
    (recurringInvoices: any[]) => {
      const data = recurringInvoices.map((ri) => ({
        template_name: ri.template_name,
        customer: ri.contact?.name || "",
        frequency: ri.frequency,
        start_date: ri.start_date,
        next_run_date: ri.next_run_date,
        end_date: ri.end_date || "",
        is_active: ri.is_active ? "Yes" : "No",
        auto_send: ri.auto_send ? "Yes" : "No",
        invoices_generated: ri.invoices_generated || 0,
        currency: ri.currency,
      }));

      exportToCSV(data, {
        filename: `recurring_invoices_${new Date().toISOString().split("T")[0]}`,
        headers: [
          "template_name",
          "customer",
          "frequency",
          "start_date",
          "next_run_date",
          "end_date",
          "is_active",
          "auto_send",
          "invoices_generated",
          "currency",
        ],
      });
    },
    [exportToCSV]
  );

  const exportEstimates = useCallback(
    (estimates: any[]) => {
      const data = estimates.map((e) => ({
        estimate_number: e.estimate_number,
        customer: e.contact?.name || "",
        issue_date: e.issue_date,
        expiry_date: e.expiry_date,
        status: e.status,
        subtotal: e.subtotal,
        tax_amount: e.tax_amount,
        discount_amount: e.discount_amount || 0,
        total: e.total,
        currency: e.currency,
      }));

      exportToCSV(data, {
        filename: `estimates_${new Date().toISOString().split("T")[0]}`,
        headers: [
          "estimate_number",
          "customer",
          "issue_date",
          "expiry_date",
          "status",
          "subtotal",
          "tax_amount",
          "discount_amount",
          "total",
          "currency",
        ],
      });
    },
    [exportToCSV]
  );

  const exportCreditNotes = useCallback(
    (creditNotes: any[]) => {
      const data = creditNotes.map((cn) => ({
        credit_note_number: cn.credit_note_number,
        customer: cn.contact?.name || "",
        issue_date: cn.issue_date,
        reason: cn.reason,
        status: cn.status,
        subtotal: cn.subtotal,
        tax_amount: cn.tax_amount,
        total: cn.total,
        amount_applied: cn.amount_applied || 0,
        available: cn.total - (cn.amount_applied || 0),
        currency: cn.currency,
      }));

      exportToCSV(data, {
        filename: `credit_notes_${new Date().toISOString().split("T")[0]}`,
        headers: [
          "credit_note_number",
          "customer",
          "issue_date",
          "reason",
          "status",
          "subtotal",
          "tax_amount",
          "total",
          "amount_applied",
          "available",
          "currency",
        ],
      });
    },
    [exportToCSV]
  );

  const exportPurchaseOrders = useCallback(
    (purchaseOrders: any[]) => {
      const data = purchaseOrders.map((po) => ({
        po_number: po.po_number,
        vendor: po.vendor?.name || "",
        order_date: po.order_date,
        expected_date: po.expected_date || "",
        status: po.status,
        subtotal: po.subtotal,
        tax_amount: po.tax_amount,
        discount_amount: po.discount_amount || 0,
        total: po.total,
        currency: po.currency,
      }));

      exportToCSV(data, {
        filename: `purchase_orders_${new Date().toISOString().split("T")[0]}`,
        headers: [
          "po_number",
          "supplier",
          "order_date",
          "expected_date",
          "status",
          "subtotal",
          "tax_amount",
          "discount_amount",
          "total",
          "currency",
        ],
      });
    },
    [exportToCSV]
  );

  const exportAccounts = useCallback(
    (accounts: any[]) => {
      const data = accounts.map((a) => ({
        code: a.code,
        name: a.name,
        type: a.account_type,
        description: a.description || "",
        opening_balance: a.opening_balance || 0,
        current_balance: a.current_balance || 0,
        is_active: a.is_active ? "Yes" : "No",
        is_system: a.is_system ? "Yes" : "No",
      }));

      exportToCSV(data, {
        filename: `accounts_${new Date().toISOString().split("T")[0]}`,
        headers: [
          "code",
          "name",
          "type",
          "description",
          "opening_balance",
          "current_balance",
          "is_active",
          "is_system",
        ],
      });
    },
    [exportToCSV]
  );

  const exportSalesOrders = useCallback(
    (salesOrders: any[]) => {
      const data = salesOrders.map((so) => ({
        so_number: so.so_number,
        customer: so.contact?.name || "",
        order_date: so.order_date,
        expected_date: so.expected_date || "",
        status: so.status,
        subtotal: so.subtotal,
        tax_amount: so.tax_amount,
        total: so.total,
        currency: so.currency,
      }));

      exportToCSV(data, {
        filename: `sales_orders_${new Date().toISOString().split("T")[0]}`,
        headers: [
          "so_number",
          "customer",
          "order_date",
          "expected_date",
          "status",
          "subtotal",
          "tax_amount",
          "total",
          "currency",
        ],
      });
    },
    [exportToCSV]
  );

  const exportDeliveryNotes = useCallback(
    (deliveryNotes: any[]) => {
      const data = deliveryNotes.map((dn) => ({
        delivery_number: dn.delivery_number,
        customer: dn.contact?.name || "",
        delivery_date: dn.delivery_date,
        status: dn.status,
        driver_name: dn.driver_name || "",
        vehicle_number: dn.vehicle_number || "",
        sales_order: dn.sales_order?.so_number || "",
      }));

      exportToCSV(data, {
        filename: `delivery_notes_${new Date().toISOString().split("T")[0]}`,
        headers: [
          "delivery_number",
          "customer",
          "delivery_date",
          "status",
          "driver_name",
          "vehicle_number",
          "sales_order",
        ],
      });
    },
    [exportToCSV]
  );

  const exportEmployees = useCallback(
    (employees: any[]) => {
      const data = employees.map((emp) => ({
        employee_number: emp.employee_number,
        first_name: emp.first_name,
        last_name: emp.last_name,
        email: emp.email || "",
        phone: emp.phone || "",
        department: emp.department || "",
        position: emp.position || "",
        employment_type: emp.employment_type,
        hire_date: emp.hire_date,
        is_active: emp.is_active ? "Yes" : "No",
        basic_salary: emp.basic_salary,
      }));

      exportToCSV(data, {
        filename: `employees_${new Date().toISOString().split("T")[0]}`,
        headers: [
          "employee_number",
          "first_name",
          "last_name",
          "email",
          "phone",
          "department",
          "position",
          "employment_type",
          "hire_date",
          "is_active",
          "basic_salary",
        ],
      });
    },
    [exportToCSV]
  );

  const exportJournalEntries = useCallback(
    (entries: any[]) => {
      const data = entries.map((e) => ({
        entry_number: e.entry_number,
        entry_date: e.entry_date,
        description: e.description,
        reference: e.reference || "",
        total_debit: e.total_debit || 0,
        total_credit: e.total_credit || 0,
        status: e.status,
        is_adjusting: e.is_adjusting ? "Yes" : "No",
        is_closing: e.is_closing ? "Yes" : "No",
      }));

      exportToCSV(data, {
        filename: `journal_entries_${new Date().toISOString().split("T")[0]}`,
        headers: [
          "entry_number",
          "entry_date",
          "description",
          "reference",
          "total_debit",
          "total_credit",
          "status",
          "is_adjusting",
          "is_closing",
        ],
      });
    },
    [exportToCSV]
  );

  return {
    exportToCSV,
    exportToJSON,
    exportInvoices,
    exportExpenses,
    exportContacts,
    exportPayments,
    exportBills,
    exportProducts,
    exportRecurringInvoices,
    exportEstimates,
    exportCreditNotes,
    exportPurchaseOrders,
    exportAccounts,
    exportSalesOrders,
    exportDeliveryNotes,
    exportEmployees,
    exportJournalEntries,
  };
}

function escapeCSVValue(value: string): string {
  if (value.includes(",") || value.includes('"') || value.includes("\n")) {
    return `"${value.replace(/"/g, '""')}"`;
  }
  return value;
}

function formatValue(value: any): string {
  if (value === null || value === undefined) {
    return "";
  }
  if (typeof value === "object") {
    return JSON.stringify(value);
  }
  return String(value);
}

function downloadFile(content: string, filename: string, mimeType: string) {
  // CSV goes through the canonical writer (BOM + CRLF); other MIME
  // types (JSON, plaintext) still use a raw Blob download.
  if (mimeType.startsWith("text/csv")) {
    downloadCsv(filename, content);
    return;
  }
  const blob = new Blob([content], { type: mimeType });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
  URL.revokeObjectURL(url);
}
// Silence "unused import" if `csvBlob` isn't referenced yet elsewhere.
void csvBlob;
