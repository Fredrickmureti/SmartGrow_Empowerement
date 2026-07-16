/**
 * PublisherGovernanceEditor — manages who can author/publish a pack.
 *
 * Lives as a tab inside `<PackEditorShell />`. Lists every grantee on the
 * pack's publisher organisation, allows owners (and platform admins) to
 * invite new grantees by email, change roles, and revoke access. All
 * writes are RLS-checked at the DB tier; the editor does not gate itself
 * by role beyond hiding the destructive controls when no rows exist.
 *
 * Why email-based invite: pack authors live across organisations
 * (a Ghana accountant working on Ghana while a Kenyan firm maintains Kenya).
 * Looking them up by user_id is friction; email + a profiles lookup is the
 * canonical onboarding path elsewhere in the app.
 */
import { useState } from "react";
import { toast } from "sonner";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from "@/components/ui/select";
import { Loader2, ShieldCheck, Trash2, UserPlus } from "lucide-react";
import { LocalizationFormShell } from "./_shared/LocalizationFormShell";
import { WorkflowSheetSection, WorkflowSheetGrid, WorkflowField } from "@/components/workflow/WorkflowSheet";
import {
  usePublisherGrants, useAddPublisherGrant, useUpdatePublisherGrant, useRemovePublisherGrant,
  type PublisherGrantRole,
} from "../hooks/usePublisherGrants";
import { normalizeError } from "@/services/resilience";
import { LocalizationEntityWorkspace } from "./_shared/LocalizationEntityWorkspace";
import type { EntityInspectorPaneProps } from "./preview/EntityInspectorPane";

const ROLE_LABEL: Record<PublisherGrantRole, string> = {
  owner: "Owner",
  publisher: "Publisher",
  reviewer: "Reviewer",
};

const ROLE_HELP: Record<PublisherGrantRole, string> = {
  owner: "Full control. Can grant/revoke other publishers and publish versions.",
  publisher: "Authors and publishes pack content. Cannot manage grantees.",
  reviewer: "Read-only with comment surface for the upcoming 4-eyes flow.",
};

interface Props {
  packId: string | null;
}

export function PublisherGovernanceEditor({ packId }: Props) {
  const { data, isLoading } = usePublisherGrants(packId);
  const add = useAddPublisherGrant();
  const update = useUpdatePublisherGrant();
  const remove = useRemovePublisherGrant();

  const [inviteOpen, setInviteOpen] = useState(false);
  const [inviteEmail, setInviteEmail] = useState("");
  const [inviteRole, setInviteRole] = useState<PublisherGrantRole>("publisher");

  if (!packId) {
    return (
      <Card>
        <CardContent className="p-6 text-sm text-muted-foreground">
          Select a pack to manage its publishers.
        </CardContent>
      </Card>
    );
  }
  if (isLoading) {
    return (
      <div className="p-6 text-sm text-muted-foreground flex items-center gap-2">
        <Loader2 className="h-4 w-4 animate-spin" /> Loading publishers…
      </div>
    );
  }
  const publisherOrgId = data?.publisherOrgId ?? null;
  if (!publisherOrgId) {
    return (
      <Card>
        <CardHeader>
          <CardTitle className="text-sm flex items-center gap-2">
            <ShieldCheck className="h-4 w-4" /> Platform-owned pack
          </CardTitle>
        </CardHeader>
        <CardContent className="text-sm text-muted-foreground space-y-2">
          <p>
            This pack has no publisher organisation, so it is maintained directly by platform
            administrators. To delegate authorship to an external accountant or payroll specialist,
            assign a publisher organisation to the pack first.
          </p>
        </CardContent>
      </Card>
    );
  }

  const grants = data?.grants ?? [];

  const handleInvite = async () => {
    try {
      await add.mutateAsync({
        publisher_org_id: publisherOrgId,
        email: inviteEmail,
        role: inviteRole,
        pack_id: packId,
      });
      toast.success(`Granted ${ROLE_LABEL[inviteRole]} to ${inviteEmail}`);
      setInviteOpen(false);
      setInviteEmail("");
      setInviteRole("publisher");
    } catch (e) {
      toast.error(normalizeError(e).message);
    }
  };

  const previewProps: EntityInspectorPaneProps = {
    title: "Publisher governance",
    kindLabel: `${grants.length} grantee${grants.length === 1 ? "" : "s"}`,
    subtitle: "Everyone who can currently author or publish this pack.",
    chips: [
      { label: `owners: ${grants.filter((g) => g.role === "owner").length}`, tone: "success" },
      { label: `publishers: ${grants.filter((g) => g.role === "publisher").length}`, tone: "default" },
      { label: `reviewers: ${grants.filter((g) => g.role === "reviewer").length}`, tone: "outline" },
    ],
    groups: [
      {
        title: "Grantees",
        fields: grants.length === 0
          ? [{ label: "No grantees", value: "Invite the first publisher to start collaborating.", fullWidth: true }]
          : grants.map((g) => ({
              label: ROLE_LABEL[g.role],
              value: g.full_name ?? g.email ?? g.user_id,
              hint: g.email ?? undefined,
              fullWidth: true,
            })),
      },
    ],
    footnote: "RLS enforces role permissions at the DB tier — this pane reflects the same source of truth.",
  };

  const editorContent = (
    <div className="flex h-full min-h-0 flex-col gap-3 overflow-auto p-3">
      <Card>
        <CardHeader className="flex flex-row items-center justify-between gap-2 space-y-0">
          <div className="space-y-1">
            <CardTitle className="text-sm">Publishers</CardTitle>
            <p className="text-xs text-muted-foreground">
              Anyone listed here can edit this pack within the limits of their role.
            </p>
          </div>
          <Button size="sm" onClick={() => setInviteOpen(true)}>
            <UserPlus className="h-3.5 w-3.5 mr-1" /> Invite publisher
          </Button>
        </CardHeader>
        <CardContent className="space-y-1">
          {grants.length === 0 && (
            <div className="text-sm text-muted-foreground py-6 text-center">
              No grantees yet. Invite the first publisher to start collaborating on this pack.
            </div>
          )}
          {grants.map((g) => (
            <div
              key={g.id}
              className="flex flex-wrap items-center justify-between gap-2 border-b last:border-0 py-2"
            >
              <div className="min-w-0">
                <div className="text-sm font-medium truncate">
                  {g.full_name ?? g.email ?? g.user_id}
                </div>
                <div className="text-xs text-muted-foreground truncate">
                  {g.email ?? <span className="font-mono">{g.user_id}</span>}
                </div>
              </div>
              <div className="flex items-center gap-2">
                <Select
                  value={g.role}
                  onValueChange={(v) =>
                    update.mutate(
                      { id: g.id, role: v as PublisherGrantRole, pack_id: packId },
                      {
                        onSuccess: () => toast.success(`Role updated to ${ROLE_LABEL[v as PublisherGrantRole]}`),
                        onError: (e) => toast.error(normalizeError(e).message),
                      },
                    )
                  }
                >
                  <SelectTrigger className="h-8 w-32"><SelectValue /></SelectTrigger>
                  <SelectContent>
                    {(Object.keys(ROLE_LABEL) as PublisherGrantRole[]).map((r) => (
                      <SelectItem key={r} value={r}>{ROLE_LABEL[r]}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                <Badge variant="outline" className="text-[10px]" title={ROLE_HELP[g.role]}>
                  {ROLE_LABEL[g.role]}
                </Badge>
                <Button
                  variant="ghost"
                  size="icon"
                  className="h-8 w-8 text-destructive"
                  onClick={() => {
                    if (!confirm(`Revoke ${g.email ?? g.user_id}?`)) return;
                    remove.mutate(
                      { id: g.id, pack_id: packId },
                      {
                        onSuccess: () => toast.success("Publisher revoked"),
                        onError: (e) => toast.error(normalizeError(e).message),
                      },
                    );
                  }}
                  aria-label="Revoke publisher"
                >
                  <Trash2 className="h-3.5 w-3.5" />
                </Button>
              </div>
            </div>
          ))}
        </CardContent>
      </Card>

      <LocalizationFormShell
        open={inviteOpen}
        onOpenChange={setInviteOpen}
        entity="publisher-grant"
        busy={add.isPending}
        submitLabel="Send invite"
        submitDisabled={!inviteEmail.trim()}
        onSubmit={handleInvite}
      >
        <WorkflowSheetSection
          number={1}
          title="Identity"
          subtitle="The teammate must have signed in to the platform at least once so a profile exists."
        >
          <WorkflowSheetGrid>
            <WorkflowField label="Email" required>
              <Input
                type="email"
                value={inviteEmail}
                onChange={(e) => setInviteEmail(e.target.value)}
                placeholder="payroll-author@example.com"
                autoFocus
              />
            </WorkflowField>
            <WorkflowField label="Role" required>
              <Select value={inviteRole} onValueChange={(v) => setInviteRole(v as PublisherGrantRole)}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  {(Object.keys(ROLE_LABEL) as PublisherGrantRole[]).map((r) => (
                    <SelectItem key={r} value={r}>
                      <div className="flex flex-col">
                        <span>{ROLE_LABEL[r]}</span>
                        <span className="text-xs text-muted-foreground">{ROLE_HELP[r]}</span>
                      </div>
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </WorkflowField>
          </WorkflowSheetGrid>
        </WorkflowSheetSection>
      </LocalizationFormShell>
    </div>
  );

  return (
    <LocalizationEntityWorkspace
      workspaceId={`publisher-governance:${packId}`}
      kind="publisher-governance"
      templateCode={packId}
      displayName="Publisher governance"
      preview={{ pane: "inspector", props: previewProps }}
      editor={editorContent}
      statusBar={
        <div className="flex items-center gap-4">
          <span>{grants.length} grantee{grants.length === 1 ? "" : "s"}</span>
          <span className="ml-auto hidden md:inline text-[10px] uppercase tracking-wide text-muted-foreground/70">
            ⌘B outline · ⌘⇧P preview · ⌘⇧F focus
          </span>
        </div>
      }
    />
  );
}
