/**
 * State-driven Self-Action Override dialog.
 *
 * Two modes:
 *  - Manual issuance ("break-glass") — admin picks the action, actor,
 *    and target record from live state. No UUID typing anywhere.
 *  - Pre-filled issuance — opened from the Blocked Attempts queue (or
 *    an inline "Request override" affordance later). Every field is
 *    locked to the values captured at the time of the refusal; the
 *    co-signer only writes a reason and signs.
 *
 * Submitted payload to `self_action_overrides` is byte-identical in
 * both modes — the DB trigger `self_action_overrides_immutable` and
 * the consumption path in `governance_assert_not_self` continue to
 * work as-is.
 */
import { useEffect, useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
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
import { Textarea } from "@/components/ui/textarea";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { ShieldAlert, Loader2, Lock } from "lucide-react";
import { supabase } from "@/integrations/supabase/client";
import { useToast } from "@/hooks/use-toast";
import { useAuth } from "@/contexts/AuthContext";
import {
  SELF_ACTION_CATALOGUE,
  ENTITY_TYPE_DB_KEY,
  ENTITY_TYPE_LABELS,
  type SelfActionEntry,
  type SelfActionEntityType,
} from "@/lib/governance/selfActionCatalogue";
import { InternalUserPicker } from "./InternalUserPicker";
import { GovernedEntityPicker } from "./GovernedEntityPicker";
import { useOrgInternalUsers } from "@/hooks/governance/useOrgInternalUsers";
import type { GovernedEntityOption } from "@/hooks/governance/useGovernedEntityOptions";

export interface OverridePrefill {
  actionKey: string;
  actorUserId: string;
  subjectUserId: string | null;
  entityType: SelfActionEntityType;
  entityId: string;
  /** Optional human label captured from the source record. Falls back to "<entityType> <id8>". */
  entityLabel?: string;
}

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  organizationId: string;
  /** When provided, every selection is locked and only the reason is editable. */
  prefill?: OverridePrefill | null;
}

export function SelfActionOverrideDialog({
  open,
  onOpenChange,
  organizationId,
  prefill = null,
}: Props) {
  const { user } = useAuth();
  const queryClient = useQueryClient();
  const { toast } = useToast();

  const [actionKey, setActionKey] = useState<string>("");
  const [actorUserId, setActorUserId] = useState<string | null>(null);
  const [entity, setEntity] = useState<GovernedEntityOption | null>(null);
  const [reason, setReason] = useState("");
  // When prefill is supplied, the subject is taken verbatim from the
  // refusal record (we trust the trigger that wrote it).
  const [prefilledSubject, setPrefilledSubject] = useState<string | null>(null);

  const isPrefilled = !!prefill;

  const entry: SelfActionEntry | undefined = SELF_ACTION_CATALOGUE.find(
    (e) => e.key === actionKey,
  );

  // Reset and (re)hydrate from prefill whenever the dialog opens.
  useEffect(() => {
    if (!open) return;
    if (prefill) {
      setActionKey(prefill.actionKey);
      setActorUserId(prefill.actorUserId);
      setPrefilledSubject(prefill.subjectUserId);
      setEntity({
        id: prefill.entityId,
        label: prefill.entityLabel ?? `${prefill.entityType} ${prefill.entityId.slice(0, 8)}`,
        subject_user_id: prefill.subjectUserId,
      });
      setReason("");
    } else {
      setActionKey("");
      setActorUserId(null);
      setPrefilledSubject(null);
      setEntity(null);
      setReason("");
    }
  }, [open, prefill]);

  // In manual mode, clear the picked entity when action changes.
  useEffect(() => {
    if (isPrefilled) return;
    setEntity(null);
  }, [actionKey, isPrefilled]);

  // Subject resolution:
  //   - prefilled → trust the refusal record
  //   - manual, subjectMode=actor → actor
  //   - manual, subjectMode=from_entity → entity.subject_user_id
  const subjectUserId: string | null = isPrefilled
    ? prefilledSubject
    : entry?.subjectMode === "from_entity"
      ? entity?.subject_user_id ?? null
      : actorUserId;

  // Display name for the (auto-derived / prefilled) subject.
  const { data: users = [] } = useOrgInternalUsers(organizationId);
  const subjectUser = users.find((u) => u.user_id === subjectUserId) ?? null;
  const actorUser = users.find((u) => u.user_id === actorUserId) ?? null;

  const createOverride = useMutation({
    mutationFn: async () => {
      if (!user) throw new Error("Not signed in");
      if (!entry) throw new Error("Choose an action");
      if (!actorUserId) throw new Error("Pick the actor (approver) being overridden");
      if (!entity) throw new Error(`Pick the ${ENTITY_TYPE_LABELS[entry.entityType]}`);
      if (!subjectUserId) {
        throw new Error(
          entry.subjectMode === "from_entity"
            ? "The selected record has no linked workspace user — cannot derive subject."
            : "Subject is missing — re-pick the actor.",
        );
      }
      if (actorUserId === user.id) {
        throw new Error("You cannot co-sign your own override — the co-signer must differ from the actor.");
      }
      if (reason.trim().length < 12) {
        throw new Error("Reason must be at least 12 characters.");
      }
      const { error } = await supabase.from("self_action_overrides" as never).insert({
        organization_id: organizationId,
        actor_user_id: actorUserId,
        subject_user_id: subjectUserId,
        action_key: entry.key,
        entity_type: ENTITY_TYPE_DB_KEY[entry.entityType],
        entity_id: entity.id,
        reason: reason.trim(),
        co_signed_by: user.id,
      } as never);
      if (error) throw error;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["self-action-overrides", organizationId] });
      queryClient.invalidateQueries({ queryKey: ["sod-blocked-attempts", organizationId] });
      toast({
        title: "Override issued",
        description: "It is single-use and expires in one hour.",
      });
      onOpenChange(false);
    },
    onError: (e: unknown) => {
      toast({
        title: "Override rejected",
        description: e instanceof Error ? e.message : String(e),
        variant: "destructive",
      });
    },
  });

  const subjectDerivedLabel = entry
    ? isPrefilled
      ? "From the blocked attempt"
      : entry.subjectMode === "actor"
        ? "Same as actor"
        : `Derived from the selected ${ENTITY_TYPE_LABELS[entry.entityType]}`
    : "Pick an action first";

  const renderReadOnlyChip = (text: string, hint?: string) => (
    <div className="flex items-center justify-between rounded-md border bg-muted/30 px-3 py-2 text-sm">
      <span className="truncate">{text}</span>
      {hint && (
        <span className="text-xs text-muted-foreground ml-2 shrink-0">{hint}</span>
      )}
    </div>
  );

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <ShieldAlert className="h-5 w-5" />
            {isPrefilled ? "Co-sign override for blocked attempt" : "Issue self-action override"}
          </DialogTitle>
          <DialogDescription>
            One-time, single-use, expires in one hour. Recorded in the audit log under
            your user — you are the co-signer.
          </DialogDescription>
        </DialogHeader>

        <Alert>
          <AlertDescription className="text-xs">
            Use overrides sparingly. Every override is permanently recorded with your
            name, the actor, the subject, the record, and your reason.
          </AlertDescription>
        </Alert>

        <div className="space-y-3">
          <div className="space-y-1">
            <Label>Action</Label>
            {isPrefilled ? (
              entry ? (
                renderReadOnlyChip(`${entry.module} — ${entry.label}`, entry.key)
              ) : (
                renderReadOnlyChip(actionKey, "unknown action")
              )
            ) : (
              <Select value={actionKey} onValueChange={setActionKey}>
                <SelectTrigger>
                  <SelectValue placeholder="Pick the action being overridden" />
                </SelectTrigger>
                <SelectContent>
                  {SELF_ACTION_CATALOGUE.map((e) => (
                    <SelectItem key={e.key} value={e.key}>
                      {e.module} — {e.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            )}
            {entry && !isPrefilled && (
              <p className="text-xs text-muted-foreground">{entry.description}</p>
            )}
          </div>

          <div className="space-y-1">
            <Label>Actor (the approver being overridden)</Label>
            {isPrefilled ? (
              renderReadOnlyChip(
                actorUser ? `${actorUser.full_name} — ${actorUser.email}` : (actorUserId ?? "—"),
                "from blocked attempt",
              )
            ) : (
              <>
                <InternalUserPicker
                  organizationId={organizationId}
                  value={actorUserId}
                  onChange={setActorUserId}
                  excludeUserIds={user ? [user.id] : []}
                  placeholder="Search workspace users…"
                  disabled={!entry}
                />
                <p className="text-xs text-muted-foreground">
                  You cannot pick yourself — the co-signer (you) must differ from the actor.
                </p>
              </>
            )}
          </div>

          <div className="space-y-1">
            <Label>
              {entry ? ENTITY_TYPE_LABELS[entry.entityType] : "Record"}
            </Label>
            {isPrefilled ? (
              renderReadOnlyChip(entity?.label ?? "—", entity?.id.slice(0, 8))
            ) : (
              <GovernedEntityPicker
                organizationId={organizationId}
                entityType={entry?.entityType ?? null}
                value={entity?.id ?? null}
                onChange={setEntity}
              />
            )}
          </div>

          <div className="space-y-1">
            <Label className="flex items-center gap-1">
              <Lock className="h-3 w-3" /> Subject (auto-derived)
            </Label>
            <div className="flex items-center justify-between rounded-md border bg-muted/30 px-3 py-2 text-sm">
              <span className="truncate">
                {subjectUser
                  ? `${subjectUser.full_name} — ${subjectUser.email}`
                  : subjectUserId
                    ? subjectUserId
                    : entry?.subjectMode === "from_entity" && entity && !subjectUser
                      ? "No workspace user linked to this record"
                      : "—"}
              </span>
              <span className="text-xs text-muted-foreground ml-2 shrink-0">
                {subjectDerivedLabel}
              </span>
            </div>
          </div>

          <div className="space-y-1">
            <Label>Reason (min. 12 characters)</Label>
            <Textarea
              rows={3}
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              placeholder="e.g. CEO away, urgent statutory deadline — confirmed via board email 11 Jun"
            />
          </div>
        </div>

        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button
            onClick={() => createOverride.mutate()}
            disabled={createOverride.isPending}
          >
            {createOverride.isPending && (
              <Loader2 className="mr-2 h-4 w-4 animate-spin" />
            )}
            {isPrefilled ? "Co-sign override" : "Issue override"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
