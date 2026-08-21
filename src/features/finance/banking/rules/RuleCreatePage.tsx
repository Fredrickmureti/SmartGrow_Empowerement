/**
 * RuleCreatePage — routed `/finance/banking/rules/new`.
 *
 * Authors into `bank_reconciliation_rules` through the server write seam; the
 * browser never stamps scope. A rule created here is a rule the executor reads.
 */
import { useState, type FormEvent } from "react";
import { useSearchParams } from "react-router-dom";

import { RecordFormShell, useRecordFormSubmit } from "@/design-system";
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

export default function RuleCreatePage() {
  const [searchParams] = useSearchParams();
  const { createRule } = useReconciliationRules();
  const { accounts: glAccounts } = useAccounts();
  const { accounts: bankAccounts } = useBankAccounts();
  const { branches } = useBranches();

  // A rule can be started from a bank line the operator is looking at; the
  // line supplies the pattern and the scope, never the account.
  const [values, setValues] = useState<RuleFormValues>(() => ({
    ...emptyRuleForm,
    name: searchParams.get("name") ?? "",
    pattern: searchParams.get("pattern") ?? "",
    bank_account_id: searchParams.get("bank_account_id") ?? "",
    amount_sign:
      (searchParams.get("amount_sign") as RuleFormValues["amount_sign"]) ?? "any",
  }));

  const submit = useRecordFormSubmit<boolean>({
    entityLabel: "Rule",
    mode: "create",
    redirectTo: () => "/finance/banking/rules",
  });

  const onSubmit = (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    submit.run(async () => {
      await createRule(buildRulePayload(values));
      return true;
    });
  };

  const canSubmit =
    !!values.name && !!values.pattern && !!values.counterpart_account_id;

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
        branches={branches || []}
      />
    </RecordFormShell>
  );
}
