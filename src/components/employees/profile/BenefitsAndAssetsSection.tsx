/**
 * Consolidated Benefits & Assets section.
 *
 * Merges three formerly-separate sidebar items (Loans, Benefits, Assets)
 * into a single section with tabs, reducing the profile sidebar from
 * 17 → 12 items without losing deep-linkability. Each tab is still
 * addressable via `?section=benefits&tab=loans|benefits|assets`.
 */
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import { EmployeeLoansTab } from "@/components/employees/EmployeeLoansTab";
import { EmployeeBenefitsTab } from "@/components/employees/EmployeeBenefitsTab";
import { EmployeeAssetsTab } from "@/components/employees/EmployeeAssetsTab";

export type BenefitsTab = "benefits" | "loans" | "assets";

interface Props {
  employeeId: string;
  canEdit: boolean;
  tab: BenefitsTab;
  onTabChange: (tab: BenefitsTab) => void;
}

export function BenefitsAndAssetsSection({ employeeId, canEdit, tab, onTabChange }: Props) {
  return (
    <Tabs value={tab} onValueChange={(v) => onTabChange(v as BenefitsTab)}>
      <TabsList>
        <TabsTrigger value="benefits">Benefits</TabsTrigger>
        <TabsTrigger value="loans">Loans</TabsTrigger>
        <TabsTrigger value="assets">Assets</TabsTrigger>
      </TabsList>
      <TabsContent value="benefits" className="mt-4">
        <EmployeeBenefitsTab employeeId={employeeId} canEdit={canEdit} />
      </TabsContent>
      <TabsContent value="loans" className="mt-4">
        <EmployeeLoansTab employeeId={employeeId} />
      </TabsContent>
      <TabsContent value="assets" className="mt-4">
        <EmployeeAssetsTab employeeId={employeeId} canEdit={canEdit} />
      </TabsContent>
    </Tabs>
  );
}
