/**
 * Presentation metadata for the elimination diagnosis the *server* produces.
 *
 * Nothing here infers anything from an error message. The database function
 * `consolidation_diagnose_eliminations` returns machine-readable `cause` and
 * `remedies` codes; this module only decides what those codes are called on
 * screen and where a link should go. If the engine gains a new remedy, it
 * appears here — never derived from prose.
 */

/** Cause codes emitted by `consolidation_diagnose_eliminations`. */
export type EliminationCause =
  | "within_tolerance"
  | "translation_residual"
  | "genuine_disagreement"
  | "missing_cta_account"
  | "missing_difference_account"
  | "residual_disclosed"
  | "scope_not_reportable"
  | "intercompany_flows_refused";

/** Remedy codes the engine will accept for a refusal. */
export type EliminationRemedy =
  | "set_policy_post_to_cta"
  | "set_policy_post_difference"
  | "raise_tolerance"
  | "configure_cta_account"
  | "configure_difference_account"
  | "review_intercompany"
  | "review_group_membership";

export const ELIMINATION_CAUSE_LABELS: Record<string, string> = {
  within_tolerance: "Within tolerance",
  translation_residual: "Left behind by translation",
  genuine_disagreement: "The two companies disagree",
  missing_cta_account: "No translation reserve account",
  missing_difference_account: "No difference account",
  residual_disclosed: "Residual will be disclosed",
  scope_not_reportable: "The group is not reportable yet",
  intercompany_flows_refused: "The intercompany positions were refused",
};

export const ELIMINATION_REMEDY_LABELS: Record<string, string> = {
  set_policy_post_to_cta: "Carry it to the translation reserve",
  set_policy_post_difference: "Post it to the difference account",
  raise_tolerance: "Accept gaps up to this size",
  configure_cta_account: "Choose a translation reserve account",
  configure_difference_account: "Choose a difference account",
  review_intercompany: "Review the intercompany declarations",
  review_group_membership: "Review the group's companies",
};

/**
 * A remedy the page can apply itself, by writing a policy row the engine then
 * re-reads. Anything not listed here is a link, because it needs a choice the
 * accountant has to make (which account) or evidence to look at.
 */
export const APPLICABLE_REMEDIES: readonly EliminationRemedy[] = [
  "set_policy_post_to_cta",
  "set_policy_post_difference",
  "raise_tolerance",
] as const;

export function isApplicableRemedy(code: string): code is EliminationRemedy {
  return (APPLICABLE_REMEDIES as readonly string[]).includes(code);
}

/** Stable anchor for one elimination class block in Finance settings. */
export function eliminationClassAnchor(eliminationClass: string): string {
  return `consolidation-elimination-${eliminationClass}`;
}

export const TRANSLATION_RESERVE_ANCHOR = "consolidation-translation-reserve";
export const GROUP_MEMBERS_ANCHOR = "consolidation-group-members";

/**
 * Where a non-applicable remedy sends the accountant. The group and class
 * travel in the URL so the settings screen opens on the right group and marks
 * the right block, instead of asking them to find it again.
 */
export function remedyLink(
  code: string,
  input: { groupId: string; eliminationClass?: string | null },
): string | null {
  const q = new URLSearchParams({ consolidationGroup: input.groupId });
  if (input.eliminationClass) q.set("eliminationClass", input.eliminationClass);

  switch (code) {
    case "configure_cta_account":
      return `/finance/settings?${q.toString()}#${TRANSLATION_RESERVE_ANCHOR}`;
    case "configure_difference_account":
      q.set("remedy", "configure_difference_account");
      return `/finance/settings?${q.toString()}#${
        input.eliminationClass
          ? eliminationClassAnchor(input.eliminationClass)
          : "consolidation-elimination-policy"
      }`;
    case "review_group_membership":
      return `/finance/settings?${q.toString()}#${GROUP_MEMBERS_ANCHOR}`;
    case "review_intercompany":
      return `/finance/reports/intercompany`;
    default:
      return null;
  }
}
