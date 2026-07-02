import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Button } from "@/components/ui/button";
import {
  Eye, Pencil, Mail, Link as LinkIcon, UserPlus, UserCheck, UserX,
  Trash2, MoreHorizontal, ArrowRightLeft, Banknote,
} from "lucide-react";
import type { Employee } from "@/hooks/useEmployees";

export function RowActions({
  employee, canManage, isOwner = false,
  onView, onEdit, onInvite, onLink, onSetManager, onTransfer, onChangeComp, onToggleStatus, onTerminate, onDelete,
}: {
  employee: Employee;
  canManage: boolean;
  isOwner?: boolean;
  onView: () => void;
  onEdit: () => void;
  onInvite: () => void;
  onLink: () => void;
  onSetManager: () => void;
  onTransfer: () => void;
  onChangeComp: () => void;
  onToggleStatus: () => void;
  onTerminate: () => void;
  onDelete: () => void;
}) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="ghost" size="icon" className="h-8 w-8">
          <MoreHorizontal className="h-4 w-4" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        <DropdownMenuItem onClick={onView}>
          <Eye className="mr-2 h-4 w-4" />View Profile
        </DropdownMenuItem>
        {canManage && (
          <>
            <DropdownMenuItem onClick={onEdit}>
              <Pencil className="mr-2 h-4 w-4" />Edit
            </DropdownMenuItem>
            <DropdownMenuSeparator />
            {!employee.user_id && (
              <DropdownMenuItem onClick={onInvite}>
                <Mail className="mr-2 h-4 w-4" />Invite to System
              </DropdownMenuItem>
            )}
            <DropdownMenuItem onClick={onLink}>
              <LinkIcon className="mr-2 h-4 w-4" />
              {employee.user_id ? "Change User Link" : "Link User Account"}
            </DropdownMenuItem>
            <DropdownMenuItem onClick={onSetManager}>
              <UserPlus className="mr-2 h-4 w-4" />
              {employee.manager_id ? "Change Manager" : "Set Manager"}
            </DropdownMenuItem>
            {employee.is_active && (
              <>
                <DropdownMenuItem onClick={onTransfer}>
                  <ArrowRightLeft className="mr-2 h-4 w-4" />Transfer / Promote
                </DropdownMenuItem>
                <DropdownMenuItem onClick={onChangeComp}>
                  <Banknote className="mr-2 h-4 w-4" />Change Compensation
                </DropdownMenuItem>
              </>
            )}
            <DropdownMenuSeparator />
            {isOwner ? (
              <DropdownMenuItem disabled>
                <UserCheck className="mr-2 h-4 w-4" />Workspace owner — protected
              </DropdownMenuItem>
            ) : (
              <>
                <DropdownMenuItem onClick={onToggleStatus}>
                  {employee.is_active
                    ? (<><UserX className="mr-2 h-4 w-4" />Deactivate</>)
                    : (<><UserCheck className="mr-2 h-4 w-4" />Activate</>)}
                </DropdownMenuItem>
                {employee.is_active ? (
                  <DropdownMenuItem onClick={onTerminate} className="text-destructive">
                    <UserX className="mr-2 h-4 w-4" />Terminate (Offboard)
                  </DropdownMenuItem>
                ) : (
                  // Hard delete is only offered for employees that are NOT active
                  // (never onboarded, or already terminated with no lingering
                  // records). The DB still enforces FK integrity — if any
                  // contract / payslip / payroll record exists, the delete
                  // is refused and we surface a "use Terminate" message.
                  <DropdownMenuItem onClick={onDelete} className="text-destructive">
                    <Trash2 className="mr-2 h-4 w-4" />Delete permanently
                  </DropdownMenuItem>
                )}
              </>
            )}
          </>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}