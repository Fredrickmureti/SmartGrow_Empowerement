/**
 * Contracts section with embedded Compensation history tab.
 *
 * Compensation history is the audit trail of contract-driven pay changes,
 * so it belongs alongside contracts rather than as a separate sidebar
 * item. Deep-link: `?section=contracts&tab=history`.
 */
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import { EmployeeContractsTab } from "@/components/employees/EmployeeContractsTab";
import { EmployeeCompensationHistoryTab } from "@/components/employees/EmployeeCompensationHistoryTab";

export type ContractsTab = "info" | "history";

interface Props {
  employeeId: string;
  canEdit: boolean;
  tab: ContractsTab;
  onTabChange: (tab: ContractsTab) => void;
}

export function ContractsSection({ employeeId, canEdit, tab, onTabChange }: Props) {
  return (
    <Tabs value={tab} onValueChange={(v) => onTabChange(v as ContractsTab)}>
      <TabsList>
        <TabsTrigger value="info">Contracts</TabsTrigger>
        <TabsTrigger value="history">Compensation history</TabsTrigger>
      </TabsList>
      <TabsContent value="info" className="mt-4">
        <EmployeeContractsTab employeeId={employeeId} canEdit={canEdit} />
      </TabsContent>
      <TabsContent value="history" className="mt-4">
        <EmployeeCompensationHistoryTab employeeId={employeeId} />
      </TabsContent>
    </Tabs>
  );
}
