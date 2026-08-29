/**
 * Assets section — company property issued to an employee.
 *
 * Benefits and staff-loan tabs were retired with the HR excision; assets
 * remain because branch equipment custody is still tracked.
 */
import { EmployeeAssetsTab } from "@/components/employees/EmployeeAssetsTab";

export type BenefitsTab = "assets";

interface Props {
  employeeId: string;
  canEdit: boolean;
  tab?: BenefitsTab;
  onTabChange?: (tab: BenefitsTab) => void;
}

export function BenefitsAndAssetsSection({ employeeId, canEdit }: Props) {
  return <EmployeeAssetsTab employeeId={employeeId} canEdit={canEdit} />;
}
