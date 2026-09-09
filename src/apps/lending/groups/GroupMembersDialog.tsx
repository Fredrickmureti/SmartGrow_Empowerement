/**
 * Group membership roll (C3).
 *
 * Add members from the client register, change role, and exit members.
 * Exiting is non-destructive: the row is retained with an exit date.
 */

import { useMemo, useState } from "react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { EmptyState, LoadingState, ErrorState, StatusBadge } from "@/design-system";
import { useMfClients, type MfClient } from "@/hooks/useMfClients";
import { useMfGroupMembers, type MfGroup } from "@/hooks/useMfGroups";
import {
  useMfClientFeePosition,
  useMfGroupFeePositions,
} from "@/hooks/useMfFeeCollections";

const ROLES = ["member", "leader", "secretary", "treasurer"] as const;

interface GroupMembersDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  group: MfGroup | null;
}

export function GroupMembersDialog({
  open,
  onOpenChange,
  group,
}: GroupMembersDialogProps) {
  const { clients } = useMfClients({
    branchId: group?.branch_id ?? null,
    status: "all",
  });
  const { members, isLoading, error, addMember, setRole, exitMember } =
    useMfGroupMembers(open && group ? group.id : null);
  const [selectedClient, setSelectedClient] = useState<string>("");
  const { data: feePositions = [] } = useMfGroupFeePositions(
    open && group ? group.id : null,
  );
  const { data: selectedFee } = useMfClientFeePosition(selectedClient || null);
  const feeByClient = useMemo(
    () => new Map(feePositions.map((p) => [p.client_id, p])),
    [feePositions],
  );

  const clientById = useMemo(() => {
    const map = new Map<string, MfClient>();
    for (const c of clients) map.set(c.id, c);
    return map;
  }, [clients]);

  const activeIds = new Set(members.filter((m) => m.is_active).map((m) => m.client_id));
  const addable = clients.filter((c) => !activeIds.has(c.id));

  const add = async () => {
    if (!group || !selectedClient) return;
    await addMember.mutateAsync({
      businessId: group.business_id,
      clientId: selectedClient,
      roleInGroup: "member",
    });
    setSelectedClient("");
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-3xl">
        <DialogHeader>
          <DialogTitle>{group ? `${group.name} — membership` : "Membership"}</DialogTitle>
          <DialogDescription>
            Membership is a collection structure only. Each member borrows on
            their own individual liability.
          </DialogDescription>
        </DialogHeader>

        <div className="flex items-end gap-2">
          <div className="flex-1">
            <Select value={selectedClient} onValueChange={setSelectedClient}>
              <SelectTrigger>
                <SelectValue placeholder="Select a client to add…" />
              </SelectTrigger>
              <SelectContent>
                {addable.map((c) => (
                  <SelectItem key={c.id} value={c.id}>
                    {c.client_number} — {c.full_name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <Button onClick={add} disabled={!selectedClient || addMember.isPending}>
            Add member
          </Button>
        </div>

        {selectedFee && Number(selectedFee.outstanding_amount) > 0 ? (
          <p className="rounded-md border bg-muted/40 px-3 py-2 text-sm text-muted-foreground">
            This client has an outstanding admission fee of{" "}
            <span className="font-medium text-foreground">
              {selectedFee.currency_code ?? ""}{" "}
              {Number(selectedFee.outstanding_amount).toLocaleString(undefined, {
                minimumFractionDigits: 2,
                maximumFractionDigits: 2,
              })}
            </span>
            . Adding them to the group does not collect it — use “Admission fees” on the
            group when the money is actually received.
          </p>
        ) : null}

        {error ? (
          <ErrorState description={error.message} />
        ) : isLoading ? (
          <LoadingState />
        ) : members.length === 0 ? (
          <EmptyState
            title="No members yet"
            description="Add clients from this branch to build the membership roll."
          />
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Client</TableHead>
                <TableHead>Role</TableHead>
                <TableHead>Joined</TableHead>
                <TableHead>Status</TableHead>
                <TableHead>Admission fee</TableHead>
                <TableHead className="text-right">Action</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {members.map((m) => {
                const client = clientById.get(m.client_id);
                return (
                  <TableRow key={m.id}>
                    <TableCell className="font-medium">
                      {client ? `${client.client_number} — ${client.full_name}` : m.client_id}
                    </TableCell>
                    <TableCell>
                      {m.is_active ? (
                        <Select
                          value={m.role_in_group}
                          onValueChange={(v) =>
                            setRole.mutate({ id: m.id, roleInGroup: v })
                          }
                        >
                          <SelectTrigger className="h-8 w-[150px] text-sm">
                            <SelectValue />
                          </SelectTrigger>
                          <SelectContent>
                            {ROLES.map((r) => (
                              <SelectItem key={r} value={r}>
                                {r}
                              </SelectItem>
                            ))}
                          </SelectContent>
                        </Select>
                      ) : (
                        m.role_in_group
                      )}
                    </TableCell>
                    <TableCell>{m.joined_on}</TableCell>
                    <TableCell>
                      <StatusBadge tone={m.is_active ? "success" : "neutral"}>
                        {m.is_active ? "active" : `exited ${m.exited_on ?? ""}`}
                      </StatusBadge>
                    </TableCell>
                    <TableCell className="text-right">
                      {m.is_active ? (
                        <Button
                          variant="outline"
                          size="sm"
                          onClick={() => exitMember.mutate(m.id)}
                        >
                          Exit
                        </Button>
                      ) : null}
                    </TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
        )}
      </DialogContent>
    </Dialog>
  );
}

export default GroupMembersDialog;
