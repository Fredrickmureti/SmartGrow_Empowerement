/**
 * RulesListPage — routed `/finance/banking/rules` list replacement for the
 * legacy `TransactionRulesDialog` browse view. Uses the standard
 * `PageHeader` + `PageBody` + `Section` scaffold; row-level edit navigates
 * to the `/:id/edit` route, delete stays inline, and toggle-active is a
 * per-row switch (behaviour ported verbatim from the dialog).
 */
import { useNavigate } from "react-router-dom";
import { Sparkles, Plus, Trash2, Edit2 } from "lucide-react";

import {
  EmptyState,
  LoadingState,
  PageBody,
  PageHeader,
  Section,
} from "@/design-system";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Switch } from "@/components/ui/switch";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { useReconciliationRules } from "@/hooks/finance/useReconciliationRules";
import { useAccounts } from "@/hooks/useAccounts";

export default function RulesListPage() {
  const navigate = useNavigate();
  const { rules, isLoading, deleteRule, updateRule } = useReconciliationRules();
  const { accounts: glAccounts } = useAccounts();

  const getAccountName = (accountId: string) => {
    const account = glAccounts?.find((a) => a.id === accountId);
    return account ? `${account.code} — ${account.name}` : accountId;
  };

  const goCreate = () => navigate("/finance/banking/rules/new");

  return (
    <>
      <PageHeader
        eyebrow="Banking"
        title={
          <span className="inline-flex items-center gap-2">
            <Sparkles className="h-5 w-5 text-primary" />
            Transaction Rules
          </span>
        }
        description="Automatically categorize and process bank transactions. Rules map to your Chart of Accounts."
        actions={
          <Button onClick={goCreate} size="sm">
            <Plus className="mr-1.5 h-4 w-4" />
            Create Rule
          </Button>
        }
      />
      <PageBody>
        <Section
          title={`${rules.length} rule${rules.length !== 1 ? "s" : ""} configured`}
        >
          {isLoading ? (
            <LoadingState />
          ) : rules.length === 0 ? (
            <EmptyState
              icon={Sparkles}
              title="No rules yet"
              description="Create a rule to automatically categorize incoming bank transactions."
              action={
                <Button onClick={goCreate} size="sm">
                  <Plus className="mr-1.5 h-4 w-4" />
                  Create Rule
                </Button>
              }
            />
          ) : (
            <div className="overflow-x-auto">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead className="text-xs sm:text-sm">Rule</TableHead>
                    <TableHead className="text-xs sm:text-sm hidden sm:table-cell">Pattern</TableHead>
                    <TableHead className="text-xs sm:text-sm hidden xs:table-cell">Applies To</TableHead>
                    <TableHead className="text-xs sm:text-sm">Posts To</TableHead>
                    <TableHead className="text-xs sm:text-sm hidden md:table-cell">Posting</TableHead>
                    <TableHead className="text-xs sm:text-sm hidden xs:table-cell">Active</TableHead>
                    <TableHead className="text-right text-xs sm:text-sm">Actions</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {rules.map((rule) => (
                    <TableRow key={rule.id}>
                      <TableCell className="font-medium text-xs sm:text-sm py-2">
                        <span className="truncate max-w-[100px] sm:max-w-none block">
                          {rule.name}
                        </span>
                      </TableCell>
                      <TableCell className="text-muted-foreground font-mono text-[10px] sm:text-xs max-w-[150px] truncate hidden sm:table-cell">
                        {rule.description_regex || rule.description_pattern || "—"}
                        {rule.description_regex && (
                          <Badge variant="outline" className="ml-1 text-[9px]">regex</Badge>
                        )}
                      </TableCell>
                      <TableCell className="hidden xs:table-cell">
                        <Badge variant="outline" className="text-[10px] sm:text-xs">
                          {rule.amount_sign === "any"
                            ? "All"
                            : rule.amount_sign === "credit"
                              ? "Money in"
                              : "Money out"}
                        </Badge>
                      </TableCell>
                      <TableCell>
                        <Badge
                          variant="secondary"
                          className="text-[10px] sm:text-xs max-w-[120px] truncate block"
                        >
                          {getAccountName(rule.counterpart_account_id)}
                        </Badge>
                      </TableCell>
                      <TableCell className="hidden md:table-cell">
                        <Badge variant="outline" className="text-[10px]">
                          {rule.auto_post ? "Auto-post" : "Propose"}
                        </Badge>
                      </TableCell>
                      <TableCell className="hidden xs:table-cell">
                        <Switch
                          checked={rule.is_active ?? true}
                          onCheckedChange={() =>
                            updateRule(rule.id, { is_active: !(rule.is_active ?? true) })
                          }
                        />
                      </TableCell>

                      <TableCell className="text-right py-2">
                        <div className="flex justify-end gap-0.5">
                          <Button
                            variant="ghost"
                            size="icon"
                            className="h-7 w-7"
                            onClick={() =>
                              navigate(`/finance/banking/rules/${rule.id}/edit`)
                            }
                            aria-label="Edit rule"
                          >
                            <Edit2 className="h-4 w-4" />
                          </Button>
                          <Button
                            variant="ghost"
                            size="icon"
                            className="h-7 w-7"
                            disabled={isLoading}
                            disabled={isSaving}
                            aria-label="Delete rule"
                          >
                            <Trash2 className="h-4 w-4 text-destructive" />
                          </Button>
                        </div>
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          )}
        </Section>
      </PageBody>
    </>
  );
}
