/**
 * Regression test for the multi-entity branding boundary.
 *
 * Scenario: the user has selected business B in their session, but is
 * rendering a document (invoice, bill, statement) that belongs to
 * business A. `useDocumentBranding(record.business_id)` MUST resolve
 * to business A — NEVER to the currently-selected business B and
 * NEVER to the org tenant.
 *
 * If this test ever fails, a bug has been introduced that would cause
 * customers to receive documents stamped with the wrong legal entity's
 * tax ID, address, and logo — a serious compliance issue.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderHook, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import React from "react";
import { useDocumentBranding } from "@/hooks/useDocumentBranding";

const BUSINESS_A = {
  id: "biz-a",
  name: "Acme Manufacturing Ltd",
  legal_name: "Acme Manufacturing Limited",
  tax_id: "TAX-A-111",
  registration_number: "REG-A-1",
  logo_url: "https://example.com/a.png",
  email: "a@acme.test",
  phone: "+1-111",
  website: "https://acme.test",
  address: "1 A Street",
  city: "A City",
  state: "AS",
  postal_code: "11111",
  country: "US",
  base_currency: "USD",
  invoice_prefix: "INV-A",
  estimate_prefix: "EST-A",
  bill_prefix: "BILL-A",
};

const BUSINESS_B = {
  ...BUSINESS_A,
  id: "biz-b",
  name: "Globex Trading SA",
  legal_name: "Globex Trading S.A.",
  tax_id: "TAX-B-222",
  base_currency: "EUR",
  country: "FR",
  invoice_prefix: "INV-B",
};

vi.mock("@/integrations/supabase/client", () => {
  return {
    supabase: {
      from: vi.fn((table: string) => {
        if (table !== "businesses") throw new Error(`Unexpected table ${table}`);
        return {
          select: () => ({
            eq: (_col: string, val: string) => ({
              maybeSingle: async () => {
                if (val === BUSINESS_A.id) return { data: BUSINESS_A, error: null };
                if (val === BUSINESS_B.id) return { data: BUSINESS_B, error: null };
                return { data: null, error: null };
              },
            }),
          }),
        };
      }),
    },
  };
});

// Session has business B selected — but documents must still resolve from
// the explicit business_id passed in.
vi.mock("@/hooks/useBusinesses", () => ({
  useBusinesses: () => ({ currentBusiness: BUSINESS_B }),
}));

function wrapper({ children }: { children: React.ReactNode }) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return <QueryClientProvider client={qc}>{children}</QueryClientProvider>;
}

describe("useDocumentBranding — record-scoped branding", () => {
  beforeEach(() => vi.clearAllMocks());

  it("resolves branding from the record's business_id, not the session's currentBusiness", async () => {
    const { result } = renderHook(() => useDocumentBranding(BUSINESS_A.id), { wrapper });
    await waitFor(() => expect(result.current.isLoading).toBe(false));
    expect(result.current.branding?.business_id).toBe(BUSINESS_A.id);
    expect(result.current.branding?.legal_name).toBe(BUSINESS_A.legal_name);
    expect(result.current.branding?.tax_id).toBe("TAX-A-111");
    expect(result.current.branding?.base_currency).toBe("USD");
    expect(result.current.branding?.invoice_prefix).toBe("INV-A");
    // Crucially, NOT business B's values
    expect(result.current.branding?.tax_id).not.toBe("TAX-B-222");
    expect(result.current.branding?.base_currency).not.toBe("EUR");
  });

  it("falls back to the session's currentBusiness only when no explicit id is passed", async () => {
    const { result } = renderHook(() => useDocumentBranding(), { wrapper });
    await waitFor(() => expect(result.current.isLoading).toBe(false));
    expect(result.current.branding?.business_id).toBe(BUSINESS_B.id);
    expect(result.current.branding?.tax_id).toBe("TAX-B-222");
  });
});
