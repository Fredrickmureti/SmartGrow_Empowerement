/**
 * Client detail sheet — the read-only view of an existing client.
 *
 * Clicking a client in the register means "show me this client", never "put
 * this record into an editable form". Editing is a separate, deliberate act
 * behind the Edit client action, and the three controlled fields (branch,
 * loan officer, status) each have their own focused change action because they
 * move the client between portfolios or gate lending eligibility.
 */

import { useMemo, useState } from "react";
import { Pencil } from "lucide-react";
import { DetailSheet, FooterActionBar, StatusBadge } from "@/design-system";
import { Button } from "@/components/ui/button";
import { Separator } from "@/components/ui/separator";
import { useBranches } from "@/hooks/useBranches";
import { useOrgMembers } from "@/hooks/useOrgMembers";
import { useMfClientActiveGroup } from "@/hooks/useMfClientActiveGroup";
import { useKycImageUrl, type MfClient, type MfClientStatus } from "@/hooks/useMfClients";
import { ClientAssignmentDialog, type ControlledField } from "./ClientAssignmentDialog";
import type { MfClientInput } from "@/hooks/useMfClients";

const STATUS_TONE: Record<MfClientStatus, "neutral" | "success" | "warning" | "danger"> = {
  prospect: "neutral",
  active: "success",
  dormant: "warning",
  exited: "neutral",
  blacklisted: "danger",
};

function Field({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="min-w-0">
      <div className="text-xs text-muted-foreground">{label}</div>
      <div className="break-words text-sm font-medium [overflow-wrap:anywhere]">
        {value === null || value === undefined || value === "" ? "—" : value}
      </div>
    </div>
  );
}

function Block({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="space-y-3">
      <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
        {title}
      </h3>
      <div className="grid gap-4 sm:grid-cols-2">{children}</div>
    </section>
  );
}

function KycImage({ label, path }: { label: string; path: string | null }) {
  const { data: url } = useKycImageUrl(path);
  return (
    <div className="space-y-1">
      <div className="text-xs text-muted-foreground">{label}</div>
      {url ? (
        <img
          src={url}
          alt={label}
          loading="lazy"
          className="h-28 w-full rounded-md border object-cover"
        />
      ) : (
        <div className="flex h-28 w-full items-center justify-center rounded-md border border-dashed text-xs text-muted-foreground">
          Not captured
        </div>
      )}
    </div>
  );
}

interface Props {
  client: MfClient | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  canManage: boolean;
  onEdit: () => void;
  onUpdate: (id: string, patch: Partial<MfClientInput>) => Promise<void>;
}

export function ClientDetailSheet({
  client,
  open,
  onOpenChange,
  canManage,
  onEdit,
  onUpdate,
}: Props) {
  const { branches } = useBranches();
  const { getUserName } = useOrgMembers();
  const { group } = useMfClientActiveGroup(open ? (client?.id ?? null) : null);
  const [controlled, setControlled] = useState<ControlledField | null>(null);

  const branchName = useMemo(
    () => branches.find((b) => b.id === client?.branch_id)?.name ?? "—",
    [branches, client?.branch_id],
  );

  if (!client) return null;

  const changeAction = (field: ControlledField, label: string) =>
    canManage ? (
      <button
        type="button"
        className="text-xs text-primary underline-offset-2 hover:underline"
        onClick={() => setControlled(field)}
      >
        {label}
      </button>
    ) : null;

  return (
    <>
      <DetailSheet
        open={open}
        onOpenChange={onOpenChange}
        size="lg"
        title={
          <span className="flex min-w-0 items-center gap-2">
            <span className="truncate">{client.full_name}</span>
            <StatusBadge tone={STATUS_TONE[client.status]}>{client.status}</StatusBadge>
          </span>
        }
        description={`Client ${client.client_number} · stored record`}
        footer={
          <FooterActionBar
            anchor="sheet"
            trailing={
              <>
                <Button variant="outline" onClick={() => onOpenChange(false)}>
                  Close
                </Button>
                {canManage && (
                  <Button onClick={onEdit}>
                    <Pencil className="mr-1.5 h-4 w-4" />
                    Edit client
                  </Button>
                )}
              </>
            }
          />
        }
      >
        <div className="space-y-6">
          <div className="flex gap-4">
            <div className="w-28 shrink-0">
              <KycImage label="Photo" path={client.photo_path} />
            </div>
            <div className="grid flex-1 gap-4 sm:grid-cols-2">
              <Field label="Client number" value={client.client_number} />
              <Field label="Joined on" value={client.joined_on} />
              <Field label="National ID" value={client.national_id} />
              <Field label="Completed cycles" value={client.completed_cycles} />
            </div>
          </div>

          <Separator />

          <Block title="Assignment">
            <Field
              label="Branch"
              value={
                <span className="flex items-center gap-2">
                  {branchName}
                  {changeAction("branch", "Change")}
                </span>
              }
            />
            <Field
              label="Loan officer"
              value={
                <span className="flex items-center gap-2">
                  {client.loan_officer_id ? getUserName(client.loan_officer_id) : "Unassigned"}
                  {changeAction("officer", "Reassign")}
                </span>
              }
            />
            <Field
              label="Status"
              value={
                <span className="flex items-center gap-2">
                  {client.status}
                  {changeAction("status", "Change")}
                </span>
              }
            />
            <Field
              label="Group"
              value={group ? `${group.name} (${group.group_number})` : "No active group"}
            />
          </Block>

          <Separator />

          <Block title="Contact">
            <Field label="Phone" value={client.phone} />
            <Field label="Email" value={client.email} />
            <Field label="Physical address" value={client.physical_address} />
            <Field label="Date of birth" value={client.date_of_birth} />
            <Field label="Gender" value={client.gender} />
          </Block>

          <Separator />

          <Block title="Livelihood">
            <Field label="Occupation" value={client.occupation} />
            <Field label="Business type" value={client.business_type} />
            <Field label="Business location" value={client.business_location} />
          </Block>

          <Separator />

          <Block title="Next of kin">
            <Field label="Name" value={client.next_of_kin_name} />
            <Field label="Relationship" value={client.next_of_kin_relationship} />
            <Field label="Phone" value={client.next_of_kin_phone} />
          </Block>

          <Separator />

          <section className="space-y-3">
            <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
              Identity documents
            </h3>
            <div className="grid gap-4 sm:grid-cols-2">
              <KycImage label="ID card — front" path={client.id_front_path} />
              <KycImage label="ID card — back" path={client.id_back_path} />
              <KycImage label="Kin ID — front" path={client.kin_id_front_path} />
              <KycImage label="Kin ID — back" path={client.kin_id_back_path} />
            </div>
          </section>

          {client.notes && (
            <>
              <Separator />
              <Block title="Notes">
                <div className="sm:col-span-2 whitespace-pre-wrap text-sm">{client.notes}</div>
              </Block>
            </>
          )}
        </div>
      </DetailSheet>

      <ClientAssignmentDialog
        field={controlled}
        client={client}
        onOpenChange={(next) => {
          if (!next) setControlled(null);
        }}
        onUpdate={onUpdate}
      />
    </>
  );
}

export default ClientDetailSheet;
