/**
 * A hand-built, factual product visual for the auth screens.
 *
 * Instead of a decorative stock/AI image, this renders a real double-entry
 * journal entry — the single idea the whole product is built on — so a first
 * time visitor understands what the system does before they even sign in.
 * Every number below balances.
 */

const lines = [
  { account: "1200 · Accounts Receivable", debit: "12,400.00", credit: null },
  { account: "4000 · Sales Revenue", debit: null, credit: "10,689.66" },
  { account: "2200 · VAT Payable (16%)", debit: null, credit: "1,710.34" },
];

const flow = [
  { step: "Invoice INV-2041", meta: "Issued · Acme Ltd" },
  { step: "Journal posted", meta: "Auto-balanced" },
  { step: "Ledger & reports", meta: "Live" },
];

export function LedgerShowcase() {
  return (
    <div className="w-full max-w-md">
      {/* Journal entry card */}
      <div className="rounded-2xl border border-primary-foreground/15 bg-primary-foreground/[0.07] backdrop-blur-sm p-5 shadow-2xl">
        <div className="flex items-baseline justify-between mb-4">
          <div>
            <div className="text-[11px] uppercase tracking-[0.18em] text-primary-foreground/60">
              Journal entry
            </div>
            <div className="text-sm font-semibold">JE-000318 · 03 Aug 2026</div>
          </div>
          <span className="rounded-full bg-primary-foreground/15 px-2.5 py-1 text-[11px] font-medium">
            Posted
          </span>
        </div>

        <div className="grid grid-cols-[1fr_auto_auto] gap-x-4 text-[11px] uppercase tracking-wider text-primary-foreground/50 pb-2 border-b border-primary-foreground/15">
          <span>Account</span>
          <span className="text-right w-20">Debit</span>
          <span className="text-right w-20">Credit</span>
        </div>

        {lines.map((l) => (
          <div
            key={l.account}
            className="grid grid-cols-[1fr_auto_auto] gap-x-4 py-2.5 text-sm border-b border-primary-foreground/10 last:border-0"
          >
            <span className="truncate text-primary-foreground/90">{l.account}</span>
            <span className="text-right w-20 tabular-nums font-medium">
              {l.debit ?? "—"}
            </span>
            <span className="text-right w-20 tabular-nums font-medium">
              {l.credit ?? "—"}
            </span>
          </div>
        ))}

        <div className="grid grid-cols-[1fr_auto_auto] gap-x-4 pt-3 mt-1 text-sm font-semibold border-t border-primary-foreground/25">
          <span className="text-primary-foreground/70">Totals</span>
          <span className="text-right w-20 tabular-nums">12,400.00</span>
          <span className="text-right w-20 tabular-nums">12,400.00</span>
        </div>

        <div className="mt-3 flex items-center gap-2 text-xs text-primary-foreground/75">
          <span className="inline-flex h-4 w-4 items-center justify-center rounded-full bg-primary-foreground/20">
            <svg viewBox="0 0 24 24" className="h-3 w-3" fill="none" stroke="currentColor" strokeWidth="3">
              <polyline points="20 6 9 17 4 12" />
            </svg>
          </span>
          Debits equal credits — the ledger cannot go out of balance.
        </div>
      </div>

      {/* Flow strip */}
      <div className="mt-4 grid grid-cols-3 gap-2">
        {flow.map((f, i) => (
          <div
            key={f.step}
            className="rounded-xl border border-primary-foreground/15 bg-primary-foreground/[0.05] px-3 py-2.5"
          >
            <div className="text-[10px] font-mono text-primary-foreground/50">
              0{i + 1}
            </div>
            <div className="text-xs font-medium leading-tight mt-0.5">{f.step}</div>
            <div className="text-[11px] text-primary-foreground/55">{f.meta}</div>
          </div>
        ))}
      </div>
    </div>
  );
}