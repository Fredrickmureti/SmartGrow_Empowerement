/**
 * Lending → Clients (C3).
 *
 * The client master: KYC identity, owning branch and loan officer, status and
 * cycle history. Clients are institution records — they survive loan closure.
 */

import { useMemo, useState } from "react";
import { usePermissions } from "@/hooks/usePermissions";
import { Plus } from "lucide-react";
import {
  PageHeader,
  PageBody,
  Section,
  FilterBar,
  EmptyState,
  LoadingState,
  ErrorState,
  StatusBadge,
} from "@/design-system";
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
import { useBranches } from "@/hooks/useBranches";
import { useOrgMembers } from "@/hooks/useOrgMembers";
import {
  MF_CLIENT_STATUSES,
  useMfClients,
  type MfClient,
  type MfClientStatus,
} from "@/hooks/useMfClients";
import { ClientFormDialog } from "./ClientFormDialog";
import { ClientDetailSheet } from "./ClientDetailSheet";
import { ClientChargesDialog } from "./ClientChargesDialog";
import { LendingDocumentsMenu } from "../documents/LendingDocumentsMenu";
import {
  useMfClientChargeSummary,
  useMfClientFeePolicy,
  type MfClientChargeStatus,
} from "@/hooks/useMfClientCharges";

const STATUS_TONE: Record<MfClientStatus, "neutral" | "success" | "warning" | "danger"> = {
  prospect: "neutral",
  active: "success",
  dormant: "warning",
  exited: "neutral",
  blacklisted: "danger",
};

const FEE_TONE: Record<MfClientChargeStatus, "neutral" | "success" | "warning" | "danger"> = {
  outstanding: "warning",
  paid: "success",
  reversed: "neutral",
};

export function ClientsPage() {
  const { can } = usePermissions();
  const canManage = can("manageClients");
  const { branches } = useBranches();
  const { getUserName } = useOrgMembers();
  const [branchId, setBranchId] = useState<string>("all");
  const [status, setStatus] = useState<MfClientStatus | "all">("all");
  const [search, setSearch] = useState("");
  // Clicking a client opens the read-only detail sheet. Editing is a separate,
  // deliberate act from inside that sheet — never the first click.
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [editing, setEditing] = useState(false);
  const [creating, setCreating] = useState(false);
  const [feeClient, setFeeClient] = useState<MfClient | null>(null);

  const { clients, isLoading, error, createClient, updateClient } = useMfClients({
    branchId: branchId === "all" ? null : branchId,
    status,
  });
  const { policy } = useMfClientFeePolicy();
  const feeActive = policy?.admission_fee_active === true;
  const clientIds = useMemo(() => clients.map((c) => c.id), [clients]);
  const { data: feeSummary } = useMfClientChargeSummary(clientIds);

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return clients;
    return clients.filter((c) =>
      [c.full_name, c.client_number, c.phone, c.national_id]
        .filter(Boolean)
        .some((v) => String(v).toLowerCase().includes(q)),
    );
  }, [clients, search]);

  const branchName = (id: string) => branches.find((b) => b.id === id)?.name ?? "—";

  // The sheet reads from the live list, so a saved edit is reflected the moment
  // the query refreshes.
  const selected = useMemo(
    () => clients.find((c) => c.id === selectedId) ?? null,
    [clients, selectedId],
  );

  const openCreate = () => {
    setSelectedId(null);
    setEditing(false);
    setCreating(true);
  };

  return (
    <>
      <PageHeader
        eyebrow="Lending"
        title="Clients"
        description="Member records with KYC identity, owning branch and loan officer."
        actions={
          canManage ? (
            <Button size="sm" onClick={openCreate}>
              <Plus className="mr-1.5 h-4 w-4" />
              Register client
            </Button>
          ) : undefined
        }
      />
      <PageBody>
        <Section title="Client register" description={`${filtered.length} client(s)`}>
          <FilterBar
            search={search}
            onSearchChange={setSearch}
            placeholder="Search name, number, phone or ID…"
          >
            <Select value={branchId} onValueChange={setBranchId}>
              <SelectTrigger className="h-8 w-[180px] text-sm">
                <SelectValue placeholder="All branches" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All branches</SelectItem>
                {branches.map((b) => (
                  <SelectItem key={b.id} value={b.id}>
                    {b.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Select
              value={status}
              onValueChange={(v) => setStatus(v as MfClientStatus | "all")}
            >
              <SelectTrigger className="h-8 w-[150px] text-sm">
                <SelectValue placeholder="All statuses" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All statuses</SelectItem>
                {MF_CLIENT_STATUSES.map((s) => (
                  <SelectItem key={s} value={s}>
                    {s}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </FilterBar>

          {error ? (
            <ErrorState description={error.message} />
          ) : isLoading ? (
            <LoadingState />
          ) : filtered.length === 0 ? (
            <EmptyState
              title="No clients yet"
              description="Register the institution's first member to start lending."
              action={canManage ? <Button onClick={openCreate}>Register client</Button> : undefined}
            />
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Number</TableHead>
                  <TableHead>Name</TableHead>
                  <TableHead>Phone</TableHead>
                  <TableHead>Branch</TableHead>
                  <TableHead>Loan officer</TableHead>
                  <TableHead className="text-right">Cycles</TableHead>
                  <TableHead>Status</TableHead>
                  {feeActive && <TableHead>Admission fee</TableHead>}
                  <TableHead className="text-right">Documents</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {filtered.map((c) => (
                  <TableRow
                    key={c.id}
                    className="cursor-pointer"
                    onClick={() => {
                      setSelectedId(c.id);
                      setEditing(false);
                    }}
                  >
                    <TableCell className="font-mono text-xs">{c.client_number}</TableCell>
                    <TableCell className="font-medium">{c.full_name}</TableCell>
                    <TableCell>{c.phone ?? "—"}</TableCell>
                    <TableCell>{branchName(c.branch_id)}</TableCell>
                    <TableCell>
                      {c.loan_officer_id ? getUserName(c.loan_officer_id) : "Unassigned"}
                    </TableCell>
                    <TableCell className="text-right">{c.completed_cycles}</TableCell>
                    <TableCell>
                      <StatusBadge tone={STATUS_TONE[c.status]}>{c.status}</StatusBadge>
                    </TableCell>
                    {feeActive && (
                      <TableCell onClick={(event) => event.stopPropagation()}>
                        <button
                          type="button"
                          className="inline-flex items-center gap-2 text-left"
                          onClick={() => setFeeClient(c)}
                        >
                          {(() => {
                            const s = feeSummary?.get(c.id);
                            return s ? (
                              <StatusBadge tone={FEE_TONE[s]}>{s}</StatusBadge>
                            ) : (
                              <StatusBadge tone="neutral">not raised</StatusBadge>
                            );
                          })()}
                          <span className="text-xs text-primary underline-offset-2 hover:underline">
                            Manage
                          </span>
                        </button>
                      </TableCell>
                    )}
                    <TableCell
                      className="text-right"
                      onClick={(event) => event.stopPropagation()}
                    >
                      <LendingDocumentsMenu
                        documents={[
                          {
                            documentType: "client_statement",
                            documentId: c.id,
                            title: "Client Statement",
                            filename: `client-statement-${c.client_number}`,
                          },
                        ]}
                      />
                    </TableCell>
                  </TableRow>
                ))}

              </TableBody>
            </Table>
          )}
        </Section>
      </PageBody>

      <ClientFormDialog
        open={dialogOpen}
        onOpenChange={setDialogOpen}
        client={editing}
        onCreate={async (input) => createClient.mutateAsync(input)}
        onUpdate={async (id, patch) => {
          await updateClient.mutateAsync({ id, ...patch });
        }}
      />
      <ClientChargesDialog
        open={feeClient !== null}
        onOpenChange={(open) => {
          if (!open) setFeeClient(null);
        }}
        client={feeClient}
        canManage={canManage}
      />
    </>
  );
}

export default ClientsPage;
