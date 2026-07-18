/**
 * useSupplierRecord — Supplier 360 aggregate read.
 *
 * Loads the supplier core row + everything the record page tabs need
 * to render (qualification cycles, compliance checks, bank accounts,
 * contracts, requisitions, PO/GR/Bill/Payment history). Each nested
 * query is scoped by business_id via the parent supplier row.
 *
 * Kept as a single hook so tab switches don't refetch; the aggregate
 * is small enough (bounded lists) to load together.
 */
import { useCallback, useEffect, useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import type { SupplierRow } from "./useSuppliers";

export interface QualificationRow {
  id: string;
  cycle_number: number;
  state:
    | "draft"
    | "submitted"
    | "approved"
    | "rejected"
    | "expired"
    | "withdrawn";
  submitted_by: string | null;
  submitted_at: string | null;
  reviewed_by: string | null;
  reviewed_at: string | null;
  decision_notes: string | null;
  score: number | null;
  expires_at: string | null;
  payload: Record<string, unknown>;
  created_at: string;
  documents?: QualificationDocumentRow[];
}

export interface QualificationDocumentRow {
  id: string;
  qualification_id: string | null;
  document_kind: string;
  document_name: string;
  issued_at: string | null;
  expires_at: string | null;
  verification_state: string;
  storage_path: string | null;
}

export interface ComplianceCheckRow {
  id: string;
  check_kind: string;
  outcome: string;
  checked_at: string | null;
  reference: string | null;
  expires_at: string | null;
  details: Record<string, unknown>;
}

export interface BankAccountRow {
  id: string;
  bank_name: string;
  account_name: string;
  account_number_masked: string;
  iban: string | null;
  swift_bic: string | null;
  currency: string | null;
  is_primary: boolean;
  is_verified: boolean;
}

export interface ContractRow {
  id: string;
  contract_number: string;
  status: string;
  start_date: string | null;
  end_date: string | null;
  ceiling_value: number | null;
  utilized_value: number | null;
  currency: string | null;
}

export interface RequisitionRow {
  id: string;
  requisition_number: string;
  status: string;
  need_by_date: string | null;
  estimated_total: number | null;
  currency: string | null;
  created_at: string;
}

export interface POHistoryRow {
  id: string;
  po_number: string;
  status: string;
  order_date: string | null;
  total: number | null;
  currency: string | null;
  billing_status: string | null;
}

export interface BillHistoryRow {
  id: string;
  bill_number: string | null;
  status: string;
  bill_date: string | null;
  total: number | null;
  amount_paid: number | null;
  currency: string | null;
}

export interface SupplierRecord extends SupplierRow {
  qualifications: QualificationRow[];
  compliance: ComplianceCheckRow[];
  bank_accounts: BankAccountRow[];
  contracts: ContractRow[];
  requisitions: RequisitionRow[];
  purchase_orders: POHistoryRow[];
  bills: BillHistoryRow[];
}

interface State {
  record: SupplierRecord | null;
  loading: boolean;
  error: string | null;
}

export function useSupplierRecord(id: string | null | undefined) {
  const [state, setState] = useState<State>({
    record: null,
    loading: !!id,
    error: null,
  });

  const load = useCallback(async () => {
    if (!id) {
      setState({ record: null, loading: false, error: null });
      return;
    }
    setState((s) => ({ ...s, loading: true, error: null }));
    const s = supabase as any;

    const { data: core, error: coreErr } = await s
      .from("suppliers")
      .select(
        "*, contact:contacts(id, name, email, phone, tax_id, address_line1, address_line2, city, country), category:supplier_categories(id, code, name)",
      )
      .eq("id", id)
      .maybeSingle();
    if (coreErr) {
      setState({ record: null, loading: false, error: coreErr.message });
      return;
    }
    if (!core) {
      setState({ record: null, loading: false, error: "Supplier not found." });
      return;
    }

    const contactId = (core as any).contact_id as string;

    const [
      quals,
      docs,
      compliance,
      banks,
      contracts,
      requisitions,
      pos,
      bills,
    ] = await Promise.all([
      s
        .from("supplier_qualifications")
        .select("*")
        .eq("supplier_id", id)
        .order("cycle_number", { ascending: false }),
      s
        .from("supplier_qualification_documents")
        .select(
          "id, qualification_id, document_kind, document_name, issued_at, expires_at, verification_state, storage_path",
        )
        .eq("supplier_id", id),
      s
        .from("supplier_compliance_checks")
        .select("*")
        .eq("supplier_id", id)
        .order("checked_at", { ascending: false }),
      s
        .from("supplier_bank_accounts")
        .select(
          "id, bank_name, account_name, account_number_masked, iban, swift_bic, currency, is_primary, is_verified",
        )
        .eq("supplier_id", id)
        .order("is_primary", { ascending: false }),
      s
        .from("procurement_contracts")
        .select(
          "id, contract_number, status, start_date, end_date, ceiling_value, utilized_value, currency",
        )
        .eq("supplier_id", id)
        .order("start_date", { ascending: false }),
      s
        .from("purchase_requisition_items")
        .select(
          "requisition:purchase_requisitions(id, requisition_number, status, need_by_date, estimated_total, currency, created_at)",
        )
        .eq("suggested_supplier_id", id)
        .limit(200),
      s
        .from("purchase_orders")
        .select(
          "id, po_number, status, order_date, total, currency, billing_status",
        )
        .eq("vendor_id", contactId)
        .order("order_date", { ascending: false })
        .limit(50),
      s
        .from("bills")
        .select(
          "id, bill_number, status, bill_date, total, amount_paid, currency",
        )
        .eq("vendor_id", contactId)
        .order("bill_date", { ascending: false })
        .limit(50),
    ]);

    const docsByQual = new Map<string | null, QualificationDocumentRow[]>();
    for (const d of (docs.data ?? []) as QualificationDocumentRow[]) {
      const k = d.qualification_id ?? null;
      const arr = docsByQual.get(k) ?? [];
      arr.push(d);
      docsByQual.set(k, arr);
    }

    const qualsWithDocs = ((quals.data ?? []) as QualificationRow[]).map(
      (q) => ({ ...q, documents: docsByQual.get(q.id) ?? [] }),
    );

    setState({
      record: {
        ...(core as any),
        qualifications: qualsWithDocs,
        compliance: (compliance.data ?? []) as ComplianceCheckRow[],
        bank_accounts: (banks.data ?? []) as BankAccountRow[],
        contracts: (contracts.data ?? []) as ContractRow[],
        requisitions: (requisitions.data ?? []) as RequisitionRow[],
        purchase_orders: (pos.data ?? []) as POHistoryRow[],
        bills: (bills.data ?? []) as BillHistoryRow[],
      },
      loading: false,
      error: null,
    });
  }, [id]);

  useEffect(() => {
    load();
  }, [load]);

  return { ...state, refresh: load };
}
