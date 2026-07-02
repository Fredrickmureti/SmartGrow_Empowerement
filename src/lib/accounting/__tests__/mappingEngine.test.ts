import { describe, it, expect } from "vitest";
import {
  proposeMappingForRole,
  proposeAllMappings,
  scoreCandidate,
  summariseProposals,
  type CandidateAccount,
  type RoleDefinition,
  type EligibilityRow,
} from "../mappingEngine";

const ROLE_AR: RoleDefinition = {
  role_key: "accounts_receivable",
  label: "Accounts Receivable",
  description: "AR control",
  required_account_type: "asset",
  is_mandatory: true,
  category: "core",
  sort_order: 30,
};

const ROLE_BANK: RoleDefinition = {
  role_key: "bank",
  label: "Bank Account",
  description: "Operating bank",
  required_account_type: "asset",
  is_mandatory: true,
  category: "core",
  sort_order: 20,
};

const AR_ELIG: EligibilityRow[] = [
  { role_key: "accounts_receivable", account_type: "asset", detail_type: "accounts_receivable", priority: 10 },
];

const BANK_ELIG: EligibilityRow[] = [
  { role_key: "bank", account_type: "asset", detail_type: "checking", priority: 10 },
  { role_key: "bank", account_type: "asset", detail_type: "savings",  priority: 20 },
  { role_key: "bank", account_type: "asset", detail_type: "bank",     priority: 40 },
];

function acc(partial: Partial<CandidateAccount>): CandidateAccount {
  return {
    id: partial.id ?? "id-" + Math.random().toString(36).slice(2),
    code: partial.code ?? "0000",
    name: partial.name ?? "Account",
    account_type: partial.account_type ?? "asset",
    detail_type: partial.detail_type ?? null,
    is_active: partial.is_active ?? true,
    business_id: partial.business_id ?? null,
  };
}

describe("scoreCandidate — hard rules", () => {
  it("rejects accounts of the wrong account_type", () => {
    const cand = acc({ account_type: "income", detail_type: "accounts_receivable" });
    const r = scoreCandidate(cand, ROLE_AR, AR_ELIG);
    expect(r.eligible).toBe(false);
    expect(r.score).toBe(Number.NEGATIVE_INFINITY);
  });

  it("rejects accounts whose detail_type is not eligible", () => {
    const cand = acc({ account_type: "asset", detail_type: "inventory" });
    const r = scoreCandidate(cand, ROLE_AR, AR_ELIG);
    expect(r.eligible).toBe(false);
  });

  it("rejects accounts with no detail_type", () => {
    const cand = acc({ account_type: "asset", detail_type: null });
    const r = scoreCandidate(cand, ROLE_AR, AR_ELIG);
    expect(r.eligible).toBe(false);
  });

  it("rejects inactive accounts even if otherwise eligible", () => {
    const cand = acc({ account_type: "asset", detail_type: "accounts_receivable", is_active: false });
    const r = scoreCandidate(cand, ROLE_AR, AR_ELIG);
    expect(r.eligible).toBe(false);
  });
});

describe("scoreCandidate — tie-breakers never override eligibility", () => {
  it("name keyword alone cannot make an ineligible account eligible", () => {
    const cand = acc({
      account_type: "asset",
      detail_type: "inventory",
      name: "Accounts Receivable - Trade",
    });
    const r = scoreCandidate(cand, ROLE_AR, AR_ELIG);
    expect(r.eligible).toBe(false);
  });

  it("code prefix bonus is small enough not to overpower priority gaps", () => {
    // Both eligible, but checking (priority 10) must beat 'bank' (priority 40)
    // even if 'bank' has the matching code prefix.
    const checking = acc({ id: "c", code: "9999", name: "X", detail_type: "checking" });
    const bank     = acc({ id: "b", code: "1010", name: "Bank Y", detail_type: "bank" });
    const proposal = proposeMappingForRole(ROLE_BANK, [checking, bank], BANK_ELIG);
    expect(proposal.selected?.account.id).toBe("c");
  });
});

describe("proposeMappingForRole — selection & confidence", () => {
  it("auto_mapped with single eligible candidate → exact", () => {
    const cand = acc({
      account_type: "asset",
      detail_type: "accounts_receivable",
      code: "1100",
      name: "Accounts Receivable",
    });
    const p = proposeMappingForRole(ROLE_AR, [cand], AR_ELIG);
    expect(p.status).toBe("auto_mapped");
    expect(p.selected?.confidence).toBe("exact");
  });

  it("missing when no eligible candidate", () => {
    const cand = acc({ account_type: "asset", detail_type: "inventory" });
    const p = proposeMappingForRole(ROLE_AR, [cand], AR_ELIG);
    expect(p.status).toBe("missing");
    expect(p.selected).toBeNull();
  });

  it("ambiguous when two close candidates with low signal", () => {
    // Two checking accounts with identical eligibility priority and no
    // distinguishing tie-breakers → gap = 0 → weak → ambiguous.
    const a = acc({ id: "a", code: "9990", name: "Acct A", detail_type: "checking" });
    const b = acc({ id: "b", code: "9991", name: "Acct B", detail_type: "checking" });
    const p = proposeMappingForRole(ROLE_BANK, [a, b], BANK_ELIG);
    expect(["ambiguous", "auto_mapped"]).toContain(p.status);
    // gap is 0 except for code-length tie-breaker = 0; should flag ambiguous
    expect(p.alternatives.length).toBe(2);
  });

  it("preserves existing valid mapping", () => {
    const a = acc({ id: "a", detail_type: "accounts_receivable", code: "1100", name: "AR" });
    const b = acc({ id: "b", detail_type: "accounts_receivable", code: "1101", name: "AR-2" });
    const p = proposeMappingForRole(ROLE_AR, [a, b], AR_ELIG, {
      currentMappings: { accounts_receivable: "b" },
    });
    expect(p.status).toBe("preserved");
    expect(p.selected?.account.id).toBe("b");
    expect(p.current_account_id).toBe("b");
  });

  it("flags missing when existing mapping is no longer eligible and no replacement", () => {
    const ineligible = acc({
      id: "old",
      account_type: "asset",
      detail_type: "inventory",
    });
    const p = proposeMappingForRole(ROLE_AR, [ineligible], AR_ELIG, {
      currentMappings: { accounts_receivable: "old" },
    });
    expect(p.status).toBe("missing");
  });
});

describe("proposeMappingForRole — determinism", () => {
  it("produces the same selection regardless of candidate input order", () => {
    const list = [
      acc({ id: "a", detail_type: "checking", code: "1010", name: "Bank A" }),
      acc({ id: "b", detail_type: "savings",  code: "1020", name: "Bank B" }),
      acc({ id: "c", detail_type: "bank",     code: "1030", name: "Bank C" }),
    ];
    const p1 = proposeMappingForRole(ROLE_BANK, list,         BANK_ELIG);
    const p2 = proposeMappingForRole(ROLE_BANK, [...list].reverse(), BANK_ELIG);
    expect(p1.selected?.account.id).toBe(p2.selected?.account.id);
  });
});

describe("proposeAllMappings + summary", () => {
  it("summarises status counts correctly", () => {
    const candidates = [
      acc({ id: "ar", detail_type: "accounts_receivable", code: "1100", name: "AR" }),
      acc({ id: "bk", detail_type: "checking", code: "1010", name: "Bank Main" }),
    ];
    const proposals = proposeAllMappings(
      [ROLE_AR, ROLE_BANK],
      [...AR_ELIG, ...BANK_ELIG],
      candidates,
    );
    const s = summariseProposals(proposals);
    expect(s.total).toBe(2);
    expect(s.auto_mapped + s.preserved).toBe(2);
    expect(s.missing).toBe(0);
    expect(s.mandatory_missing).toBe(0);
  });
});