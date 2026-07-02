import { ConfirmDeleteDialog } from "@/components/shared/ConfirmDeleteDialog";
import { EmployeeFormDialog, type EmployeeFormData } from "@/components/employees/EmployeeFormDialog";
import { EmployeeLinkDialog } from "@/components/employees/EmployeeLinkDialog";
import { EmployeeManagerDialog } from "@/components/employees/EmployeeManagerDialog";
import { EmployeeInviteDialog } from "@/components/employees/EmployeeInviteDialog";
import { EmployeeTerminationDialog } from "@/components/hr/EmployeeTerminationDialog";
import { EmployeeTransferDialog } from "@/components/employees/EmployeeTransferDialog";
import { EmployeeCompensationChangeDialog } from "@/components/employees/EmployeeCompensationChangeDialog";
import { ImportWizard } from "@/components/common/ImportWizard";
import { EMPLOYEE_IMPORT_FIELDS } from "@/lib/importConfigs/employeeImportConfig";
import type { FieldDefinition } from "@/lib/importUtils";
import type { Employee } from "@/hooks/useEmployees";

export interface EmployeeDirectoryDialogsProps {
  /* form */
  showForm: boolean;
  setShowForm: (v: boolean) => void;
  editingEmployee: Employee | null;
  onSubmit: (data: EmployeeFormData) => Promise<void>;
  /* link/manager/invite */
  linkDialogEmployee: Employee | null;
  setLinkDialogEmployee: (e: Employee | null) => void;
  managerDialogEmployee: Employee | null;
  setManagerDialogEmployee: (e: Employee | null) => void;
  inviteDialogEmployee: Employee | null;
  setInviteDialogEmployee: (e: Employee | null) => void;
  /* delete */
  deleteConfirm: {
    isOpen: boolean;
    setIsOpen: (v: boolean) => void;
    itemToDelete: Employee | null;
    confirmDelete: () => void;
    isDeleting: boolean;
  };
  /* import */
  showImportWizard: boolean;
  setShowImportWizard: (v: boolean) => void;
  onImportEmployee: (row: Record<string, any>) => Promise<void>;
  /** Dynamic column list — composed at runtime from pack_requirements +
   *  entity_field_configs + the static core. Optional for back-compat;
   *  callers should supply it so pack / custom fields appear in the template. */
  importFieldDefinitions?: FieldDefinition[];
  /* terminate */
  terminatingEmployee: Employee | null;
  setTerminatingEmployee: (e: Employee | null) => void;
  onTerminate: (
    employeeId: string,
    data: { termination_date: string; is_active: boolean },
    exitData: any,
  ) => Promise<void>;
  /* transfer / compensation */
  transferEmployee: Employee | null;
  setTransferEmployee: (e: Employee | null) => void;
  compensationEmployee: Employee | null;
  setCompensationEmployee: (e: Employee | null) => void;
  refreshEmployees: () => void;
}

export function EmployeeDirectoryDialogs(p: EmployeeDirectoryDialogsProps) {
  return (
    <>
      <EmployeeFormDialog
        open={p.showForm}
        onOpenChange={p.setShowForm}
        editingEmployee={p.editingEmployee}
        onSubmit={p.onSubmit}
        onInvite={(e) => p.setInviteDialogEmployee(e)}
        onLink={(e) => p.setLinkDialogEmployee(e)}
        onSetManager={(e) => p.setManagerDialogEmployee(e)}
      />
      {p.linkDialogEmployee && (
        <EmployeeLinkDialog
          open
          onOpenChange={(o) => !o && p.setLinkDialogEmployee(null)}
          employeeId={p.linkDialogEmployee.id}
          employeeName={`${p.linkDialogEmployee.first_name} ${p.linkDialogEmployee.last_name}`}
          currentUserId={p.linkDialogEmployee.user_id}
          onSuccess={p.refreshEmployees}
        />
      )}
      {p.managerDialogEmployee && (
        <EmployeeManagerDialog
          open
          onOpenChange={(o) => !o && p.setManagerDialogEmployee(null)}
          employeeId={p.managerDialogEmployee.id}
          employeeName={`${p.managerDialogEmployee.first_name} ${p.managerDialogEmployee.last_name}`}
          currentManagerId={p.managerDialogEmployee.manager_id}
          onSuccess={p.refreshEmployees}
        />
      )}
      {p.inviteDialogEmployee && (
        <EmployeeInviteDialog
          open
          onOpenChange={(o) => !o && p.setInviteDialogEmployee(null)}
          employeeId={p.inviteDialogEmployee.id}
          employeeName={`${p.inviteDialogEmployee.first_name} ${p.inviteDialogEmployee.last_name}`}
          employeeEmail={p.inviteDialogEmployee.email}
          onSuccess={p.refreshEmployees}
        />
      )}
      <ConfirmDeleteDialog
        open={p.deleteConfirm.isOpen}
        onOpenChange={p.deleteConfirm.setIsOpen}
        title="Delete Employee"
        itemName={p.deleteConfirm.itemToDelete
          ? `${p.deleteConfirm.itemToDelete.first_name} ${p.deleteConfirm.itemToDelete.last_name}`
          : undefined}
        onConfirm={p.deleteConfirm.confirmDelete}
        isLoading={p.deleteConfirm.isDeleting}
      />
      <ImportWizard
        open={p.showImportWizard}
        onOpenChange={p.setShowImportWizard}
        entityName="Employee"
        fieldDefinitions={p.importFieldDefinitions ?? EMPLOYEE_IMPORT_FIELDS}
        onImport={p.onImportEmployee}
        onComplete={p.refreshEmployees}
      />
      {p.terminatingEmployee && (
        <EmployeeTerminationDialog
          employee={p.terminatingEmployee}
          open
          onOpenChange={(o) => !o && p.setTerminatingEmployee(null)}
          onTerminate={p.onTerminate}
        />
      )}
      {p.transferEmployee && (
        <EmployeeTransferDialog
          employee={p.transferEmployee}
          open
          onOpenChange={(o) => !o && p.setTransferEmployee(null)}
          onSuccess={p.refreshEmployees}
        />
      )}
      {p.compensationEmployee && (
        <EmployeeCompensationChangeDialog
          employee={p.compensationEmployee}
          open
          onOpenChange={(o) => !o && p.setCompensationEmployee(null)}
          onSuccess={p.refreshEmployees}
        />
      )}
    </>
  );
}