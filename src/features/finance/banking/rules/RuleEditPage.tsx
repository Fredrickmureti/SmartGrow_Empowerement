/**
 * RuleEditPage — routed `/finance/banking/rules/:id/edit`.
 */
import { useEffect, useState, type FormEvent } from "react";
import { useNavigate, useParams } from "react-router-dom";

import {
  ErrorState,
  LoadingState,
  RecordFormShell,
  useRecordFormSubmit,
} from "@/design-system";
import { useReconciliationRules } from "@/hooks/finance/useReconciliationRules";
import { useAccounts } from "@/hooks/useAccounts";
import { useBankAccounts } from "@/hooks/useBankAccounts";
import { useBranches } from "@/hooks/useBranches";
import {
  RuleFormBody,
  buildRulePayload,
  emptyRuleForm,
  type RuleFormValues,
} from "./RuleFormBody";

export default function RuleEditPage() {
  const { id: ruleId = "" } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const { rules, isLoading, updateRule } = useReconciliationRules();
  const { accounts: glAccounts } = useAccounts();
  const { accounts: bankAccounts } = useBankAccounts();
  const { branches } = useBranches();

  const rule = rules.find((r) => r.id === ruleId) || null;
  const [values, setValues] = useState<RuleFormValues>(emptyRuleForm);
  const [hydrated, setHydrated] = useState(false);

  useEffect(() => {
    if (!rule || hydrated) return;
    setValues({
      name: rule.name,
      pattern: rule.description_regex || rule.description_pattern || "",
      use_regex: !!rule.description_regex,
      reference_pattern: rule.reference_pattern || "",
      amount_min: rule.amount_min ?? undefined,
      amount_max: rule.amount_max ?? undefined,
      amount_sign: rule.amount_sign || "any",
      counterpart_account_id: rule.counterpart_account_id,
      description_template: rule.description_template || "",
      priority: rule.priority ?? 100,
      is_active: rule.is_active ?? true,
      auto_post: rule.auto_post ?? false,
      bank_account_id: rule.bank_account_id || "",
      branch_id: rule.branch_id || "",
    });
    setHydrated(true);
  }, [rule, hydrated]);

  const submit = useRecordFormSubmit<boolean>({
    entityLabel: "Rule",
    mode: "edit",
    redirectTo: () => "/finance/banking/rules",
  });

  const onSubmit = (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    if (!rule) return;
    submit.run(async () => {
      await updateRule(rule.id, buildRulePayload(values));
      return true;
    });
  };

  if (!rule) {
    if (isLoading) return <LoadingState />;
    return (
      <ErrorState
        title="Rule not found"
        description="This rule may have been deleted or you don't have access."
        onRetry={() => navigate("/finance/banking/rules")}
      />
    );
  }

  const canSubmit =
    !!values.name && !!values.pattern && !!values.counterpart_account_id;

  return (
    <RecordFormShell
      mode="edit"
      entityLabel="Rule"
      recordRef={rule.name}
      cancelHref="/finance/banking/rules"
      onSubmit={onSubmit}
      isSubmitting={submit.isSubmitting}
      submitDisabled={!canSubmit}
    >
      <RuleFormBody
        values={values}
        onChange={setValues}
        glAccounts={glAccounts || []}
        bankAccounts={bankAccounts || []}
        branches={branches || []}
      />
    </RecordFormShell>
  );
}
