/**
 * Controlled client changes (branch, loan officer, status).
 *
 * These three are deliberately NOT part of the generic client edit form: each
 * moves the client between portfolios or gates their lending eligibility. They
 * are changed one at a time, from the client detail sheet, so the act is
 * explicit. The database records every one of them in the activity history.
 */

import { useEffect, useState } from "react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { toast } from "sonner";
import { useAuth } from "@/contexts/AuthContext";
import { useBranches } from "@/hooks/useBranches";
import { useBranchOfficers } from "@/hooks/useBranchOfficers";
import { useBranchScope } from "@/hooks/useBranchScope";
import {
  MF_CLIENT_STATUSES,
  type MfClient,
  type MfClientInput,
  type MfClientStatus,
} from "@/hooks/useMfClients";
import { lendingErrorMessage } from "@/lib/lending/lendingError";

export type ControlledField = "branch" | "officer" | "status";

const UNASSIGNED = "__unassigned__";

const COPY: Record<ControlledField, { title: string; description: string }> = {
  branch: {
    title: "Change branch",
    description:
      "Moving a client to another branch changes who can see and work this record.",
  },
  officer: {
    title: "Reassign loan officer",
    description:
      "The new officer takes this client into their portfolio; the current one loses it.",
  },
  status: {
    title: "Change status",
    description: "Status decides whether this client may take new loans.",
  },
};

interface Props {
  field: ControlledField | null;
  client: MfClient | null;
  onOpenChange: (open: boolean) => void;
  onUpdate: (id: string, patch: Partial<MfClientInput>) => Promise<void>;
}

export function ClientAssignmentDialog({ field, client, onOpenChange, onUpdate }: Props) {
  const { branches } = useBranches();
  const { officers } = useBranchOfficers();
  const { user } = useAuth();
  const branchScope = useBranchScope();
  const [value, setValue] = useState<string>("");
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!field || !client) return;
    setValue(
      field === "branch"
        ? client.branch_id
        : field === "officer"
          ? (client.loan_officer_id ?? UNASSIGNED)
          : client.status,
    );
  }, [field, client]);

  if (!field || !client) return null;

  const allowedBranches = branches.filter((b) => branchScope.canAccessBranch(b.id));
  // Owners and administrators may own clients in any branch; everyone else
  // needs an assignment in a branch this user can operate in.
  const officerOptions = officers.filter(
    (o) =>
      o.orgWide ||
      o.branchIds.some((id) => allowedBranches.some((b) => b.id === id)),
  );
  // An own-portfolio officer may only ever own their own clients.
  const ownPortfolio = branchScope.isOwnPortfolioOnly && !!user?.id;

  const unchanged =
    field === "branch"
      ? value === client.branch_id
      : field === "officer"
        ? value === (client.loan_officer_id ?? UNASSIGNED)
        : value === client.status;

  const save = async () => {
    setSaving(true);
    try {
      const patch: Partial<MfClientInput> =
        field === "branch"
          ? { branch_id: value }
          : field === "officer"
            ? { loan_officer_id: value === UNASSIGNED ? null : value }
            : { status: value as MfClientStatus };
      await onUpdate(client.id, patch);
      onOpenChange(false);
    } catch (e) {
      toast.error(lendingErrorMessage(e, "Could not apply the change"));
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog open onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>{COPY[field].title}</DialogTitle>
          <DialogDescription>{COPY[field].description}</DialogDescription>
        </DialogHeader>

        <div className="space-y-1.5">
          <Label>{field === "branch" ? "Branch" : field === "officer" ? "Loan officer" : "Status"}</Label>
          <Select value={value} onValueChange={setValue}>
            <SelectTrigger>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {field === "branch" &&
                allowedBranches.map((b) => (
                  <SelectItem key={b.id} value={b.id}>
                    {b.name}
                  </SelectItem>
                ))}
              {field === "officer" && (
                <>
                  {!ownPortfolio && <SelectItem value={UNASSIGNED}>Unassigned</SelectItem>}
                  {(ownPortfolio
                    ? officerOptions.filter((o) => o.user_id === user!.id)
                    : officerOptions
                  ).map((o) => (
                    <SelectItem key={o.user_id} value={o.user_id}>
                      {o.name}
                    </SelectItem>
                  ))}
                </>
              )}
              {field === "status" &&
                MF_CLIENT_STATUSES.map((s) => (
                  <SelectItem key={s} value={s}>
                    {s}
                  </SelectItem>
                ))}
            </SelectContent>
          </Select>
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={saving}>
            Cancel
          </Button>
          <Button onClick={save} disabled={saving || unchanged || value === ""}>
            Apply change
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export default ClientAssignmentDialog;
