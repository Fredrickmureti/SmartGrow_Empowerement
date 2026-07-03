/**
 * RuleCreatePage — routed `/finance/banking/rules/new` replacement for the
 * legacy `TransactionRulesDialog` in create mode.
 */
import { useState, type FormEvent } from "react";
import { useNavigate } from "react-router-dom";

import { RecordFormShell, useRecordFormSubmit } from "@/design-system";
import { useTransactionRules, type TransactionRule } from "@/hooks/useTransactionRules";
import { useAccounts } from "@/hooks/useAccounts";
import { useBankAccounts } from "@/hooks/useBankAccounts";
import {
  RuleFormBody,
  buildRulePayload,
  emptyRuleForm,
  type RuleFormValues,
} from "./RuleFormBody";

export default function RuleCreatePage() {
  const navigate = useNavigate();
  const { createRule } = useTransactionRules();
  const { accounts: glAccounts } = useAccounts();
  const { accounts: bankAccounts } = useBankAccounts();

  const [values, setValues] = useState<RuleFormValues>(emptyRuleForm);

  const submit = useRecordFormSubmit<TransactionRule | null>({
    entityLabel: "Rule",
    mode: "create",
    redirectTo: () => "/finance/banking/rules",
  });

  const onSubmit = (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    submit.run(async () => {
      const result = await createRule(buildRulePayload(values));
      if (!result) throw new Error("Failed to create rule");
      return result;
    });
  };

  const canSubmit =
    !!values.rule_name && !!values.description_pattern && !!values.target_category;

  return (
    <RecordFormShell
      mode="create"
      entityLabel="Rule"
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
