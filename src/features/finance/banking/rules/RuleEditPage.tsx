/**
 * RuleEditPage — routed `/finance/banking/rules/:id/edit` replacement for
 * the legacy `TransactionRulesDialog` in edit mode.
 */
import { useEffect, useState, type FormEvent } from "react";
import { useNavigate, useParams } from "react-router-dom";

import {
  ErrorState,
  LoadingState,
  RecordFormShell,
  useRecordFormSubmit,
} from "@/design-system";
import { useTransactionRules } from "@/hooks/useTransactionRules";
import { useAccounts } from "@/hooks/useAccounts";
import { useBankAccounts } from "@/hooks/useBankAccounts";
import {
  RuleFormBody,
  buildRulePayload,
  emptyRuleForm,
  type RuleFormValues,
} from "./RuleFormBody";

export default function RuleEditPage() {
  const { id: ruleId = "" } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const { rules, isLoading, updateRule } = useTransactionRules();
  const { accounts: glAccounts } = useAccounts();
  const { accounts: bankAccounts } = useBankAccounts();

  const rule = rules.find((r) => r.id === ruleId) || null;
  const [values, setValues] = useState<RuleFormValues>(emptyRuleForm);
  const [hydrated, setHydrated] = useState(false);

  useEffect(() => {
    if (!rule || hydrated) return;
    setValues({
      rule_name: rule.rule_name,
      description_pattern: rule.description_pattern || "",
      reference_pattern: rule.reference_pattern || "",
      min_amount: rule.min_amount ?? undefined,
      max_amount: rule.max_amount ?? undefined,
      transaction_type: rule.transaction_type || "both",
      target_category: rule.target_category,
      priority: rule.priority || 0,
      is_active: rule.is_active ?? true,
      auto_action: rule.auto_action || "categorize",
      auto_post: rule.auto_post ?? false,
      auto_offset_account_id: rule.auto_offset_account_id || "",
      use_regex: rule.use_regex ?? false,
      stop_processing: rule.stop_processing ?? false,
      bank_account_id: rule.bank_account_id || "",
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
      const success = await updateRule(rule.id, buildRulePayload(values));
      if (!success) throw new Error("Failed to update rule");
      return success;
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
    !!values.rule_name && !!values.description_pattern && !!values.target_category;

  return (
    <RecordFormShell
      mode="edit"
      entityLabel="Rule"
      recordRef={rule.rule_name}
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
      />
    </RecordFormShell>
  );
}
