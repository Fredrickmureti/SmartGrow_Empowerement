# Roadmap

Authoritative detail lives in `.lovable/plan.md`.

- [ ] M1 — Operating baseline seed (accounting mappings, allocation policy, loan
      product + version, branch/officer) and one live lifecycle verification
      (client → application → approval → disbursement → repayment → batch →
      bank → reconcile), including PAR 30 semantics check and the shell
      hydration-mismatch fix.
- [ ] M2 — C15b final ERP dead-code strip (`useDashboardStats`,
      `useDashboardAnalytics`, entitlement gating, `parked-modules.d.ts` stubs)
      plus typecheck / build / permission-RLS close-out.

Done since: PAR 30 KPI corrected to a ratio; collection-batch integrity
enforced server-side (closed batches cannot be reopened, and no receipt can
join a closed batch) — verified by a self-test; preview build cache repaired.
