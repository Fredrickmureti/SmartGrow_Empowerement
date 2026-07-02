/**
 * Reporting Basis Context — accrual vs cash toggle.
 *
 * Most of our finance reports already use posted journal entries, which is
 * accrual. The cash-basis toggle re-aggregates revenue/expense based on
 * payment date instead of invoice date — used to surface a parallel
 * "cash flow" view of the same period without duplicating data.
 *
 * Components should read this context and pass `basis` to their report query
 * (e.g. `?basis=cash`) — actual cash conversion happens server-side in the
 * report RPCs (or as a post-fetch transform if the RPC is accrual-only).
 *
 * Persisted in localStorage so the user's choice survives reloads.
 */
import { createContext, useContext, useEffect, useState, ReactNode } from "react";

export type ReportingBasis = "accrual" | "cash";

interface ReportingBasisContextValue {
  basis: ReportingBasis;
  setBasis: (basis: ReportingBasis) => void;
  isCash: boolean;
  isAccrual: boolean;
}

const STORAGE_KEY = "lov.reporting_basis";

const ReportingBasisContext = createContext<ReportingBasisContextValue | undefined>(
  undefined,
);

export function ReportingBasisProvider({ children }: { children: ReactNode }) {
  const [basis, setBasisState] = useState<ReportingBasis>(() => {
    if (typeof window === "undefined") return "accrual";
    const stored = window.localStorage.getItem(STORAGE_KEY);
    return stored === "cash" ? "cash" : "accrual";
  });

  useEffect(() => {
    window.localStorage.setItem(STORAGE_KEY, basis);
  }, [basis]);

  const setBasis = (next: ReportingBasis) => setBasisState(next);

  return (
    <ReportingBasisContext.Provider
      value={{
        basis,
        setBasis,
        isCash: basis === "cash",
        isAccrual: basis === "accrual",
      }}
    >
      {children}
    </ReportingBasisContext.Provider>
  );
}

export function useReportingBasis(): ReportingBasisContextValue {
  const ctx = useContext(ReportingBasisContext);
  if (!ctx) {
    // Allow lazy use without provider — default to accrual
    return {
      basis: "accrual",
      setBasis: () => {},
      isCash: false,
      isAccrual: true,
    };
  }
  return ctx;
}
