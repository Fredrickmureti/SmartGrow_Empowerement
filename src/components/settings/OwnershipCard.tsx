/**
 * Ownership card (/settings/workspace?tab=workspace).
 *
 * Ownership is organization-level and lives on `organizations.owner_user_id`.
 * It is deliberately NOT an Access Group: the owner is the recovery anchor and
 * the only identity allowed to hand the institution over. Everything else an
 * employee can do still comes from their Access Group.
 *
 * Handover lifecycle (all enforced in the database, not here):
 *   propose_ownership_transfer  → owner only, recipient must be an active
 *                                 internal member, one pending at a time
 *   accept_ownership_transfer   → recipient only, before it expires
 *   cancel_ownership_transfer   → either party
 */
import { useEffect, useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/contexts/AuthContext";
import { useOrganization } from "@/hooks/useOrganization";
import { useToast } from "@/hooks/use-toast";
import { normalizeError } from "@/services/resilience";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Alert, AlertDescription } from "@/components/ui/alert";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Crown, Loader2, ShieldAlert } from "lucide-react";

type Candidate = { user_id: string; label: string };

type Transfer = {
  id: string;
  from_user_id: string;
  to_user_id: string;
  status: string;
  expires_at: string;
};

export function OwnershipCard() {
  const { user } = useAuth();
  const { currentOrg, refreshOrganizations } = useOrganization();
  const { toast } = useToast();

  const [isLoading, setIsLoading] = useState(true);
  const [isWorking, setIsWorking] = useState(false);
  const [ownerId, setOwnerId] = useState<string | null>(null);
  const [ownerLabel, setOwnerLabel] = useState<string>("");
  const [candidates, setCandidates] = useState<Candidate[]>([]);
  const [selected, setSelected] = useState<string>("");
  const [pending, setPending] = useState<Transfer | null>(null);
  const [confirmOpen, setConfirmOpen] = useState(false);

  const isOwner = !!user && !!ownerId && user.id === ownerId;
  const isRecipient = !!user && pending?.to_user_id === user.id;

  const load = async () => {
    if (!currentOrg || !user) return;
    setIsLoading(true);
    try {
      const [{ data: org }, { data: roles }, { data: transfers }] = await Promise.all([
        // SCOPE-EXEMPT: `organizations` is workspace-wide (no business_id column)
        supabase.from("organizations").select("owner_user_id").eq("id", currentOrg.id).maybeSingle(),
        supabase
          .from("user_roles")
          .select("user_id")
          .eq("organization_id", currentOrg.id)
          .eq("is_active", true)
          .eq("user_type", "internal"),
        // SCOPE-EXEMPT: ownership is workspace-wide
        supabase
          .from("organization_ownership_transfers")
          .select("id, from_user_id, to_user_id, status, expires_at")
          .eq("organization_id", currentOrg.id)
          .eq("status", "pending")
          .maybeSingle(),
      ]);

      const owner = org?.owner_user_id ?? null;
      setOwnerId(owner);
      setPending((transfers as Transfer | null) ?? null);

      const ids = Array.from(new Set([...(roles ?? []).map((r) => r.user_id), owner].filter(Boolean) as string[]));
      let names = new Map<string, string>();
      if (ids.length) {
        // SCOPE-EXEMPT: `profiles` is workspace-wide (no business_id column)
        const { data: profiles } = await supabase
          .from("profiles")
          .select("user_id, email, full_name")
          .in("user_id", ids);
        names = new Map((profiles ?? []).map((p) => [p.user_id, p.full_name || p.email || "Unknown"]));
      }

      setOwnerLabel(owner ? names.get(owner) ?? "Unknown" : "Not set");
      setCandidates(
        (roles ?? [])
          .filter((r) => r.user_id !== owner)
          .map((r) => ({ user_id: r.user_id, label: names.get(r.user_id) ?? "Unknown" }))
          .sort((a, b) => a.label.localeCompare(b.label)),
      );
    } catch (error) {
      toast({
        title: "Could not load ownership",
        description: normalizeError(error).message,
        variant: "destructive",
      });
    } finally {
      setIsLoading(false);
    }
  };

  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentOrg?.id, user?.id]);

  const run = async (fn: () => Promise<{ error: unknown }>, success: string) => {
    setIsWorking(true);
    try {
      const { error } = await fn();
      if (error) throw error;
      toast({ title: success });
      await load();
      await refreshOrganizations?.();
    } catch (error) {
      toast({
        title: "Action failed",
        description: normalizeError(error).message,
        variant: "destructive",
      });
    } finally {
      setIsWorking(false);
    }
  };

  const propose = () =>
    run(
      () =>
        supabase.rpc("propose_ownership_transfer", {
          p_organization_id: currentOrg!.id,
          p_to_user_id: selected,
        }) as unknown as Promise<{ error: unknown }>,
      "Handover proposed. The person you chose must accept it.",
    );

  const accept = () =>
    run(
      () =>
        supabase.rpc("accept_ownership_transfer", {
          p_transfer_id: pending!.id,
        }) as unknown as Promise<{ error: unknown }>,
      "You are now the owner of this institution.",
    );

  const cancel = () =>
    run(
      () =>
        supabase.rpc("cancel_ownership_transfer", {
          p_transfer_id: pending!.id,
        }) as unknown as Promise<{ error: unknown }>,
      "Handover cancelled.",
    );

  if (isLoading) {
    return (
      <Card>
        <CardContent className="flex items-center gap-2 py-6 text-sm text-muted-foreground">
          <Loader2 className="h-4 w-4 animate-spin" /> Loading ownership…
        </CardContent>
      </Card>
    );
  }

  const pendingName =
    pending && candidates.find((c) => c.user_id === pending.to_user_id)?.label;

  return (
    <Card>
      <CardHeader>
        <div className="flex items-start justify-between gap-3">
          <div>
            <CardTitle className="flex items-center gap-2">
              <Crown className="h-4 w-4 text-primary" />
              Ownership
            </CardTitle>
            <CardDescription>
              One person owns this institution. They can never be removed or switched off, and they
              are the only one who can hand it over.
            </CardDescription>
          </div>
        </div>
      </CardHeader>
      <CardContent className="space-y-6">
        <div className="flex items-center gap-2">
          <span className="text-sm text-muted-foreground">Current owner</span>
          <Badge variant="secondary">{ownerLabel}</Badge>
          {isOwner && <span className="text-xs text-muted-foreground">(you)</span>}
        </div>

        {pending && (
          <Alert>
            <ShieldAlert className="h-4 w-4" />
            <AlertDescription className="flex flex-col gap-3">
              <span>
                A handover to <strong>{pendingName ?? "another member"}</strong> is waiting to be
                accepted. It expires on {new Date(pending.expires_at).toLocaleDateString()}.
              </span>
              <div className="flex gap-2">
                {isRecipient && (
                  <Button size="sm" onClick={accept} disabled={isWorking}>
                    {isWorking && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
                    Accept ownership
                  </Button>
                )}
                {(isOwner || isRecipient) && (
                  <Button size="sm" variant="outline" onClick={cancel} disabled={isWorking}>
                    Cancel handover
                  </Button>
                )}
              </div>
            </AlertDescription>
          </Alert>
        )}

        {isOwner && !pending && (
          <div className="space-y-3 max-w-md border-t pt-6">
            <Label htmlFor="ownership-recipient">Hand ownership to</Label>
            <Select value={selected} onValueChange={setSelected}>
              <SelectTrigger id="ownership-recipient">
                <SelectValue placeholder="Choose a staff member" />
              </SelectTrigger>
              <SelectContent>
                {candidates.map((c) => (
                  <SelectItem key={c.user_id} value={c.user_id}>
                    {c.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <p className="text-xs text-muted-foreground">
              Only active staff of this institution can be chosen. They must accept before anything
              changes, and you stay on as a normal member afterwards.
            </p>
            <Button disabled={!selected || isWorking} onClick={() => setConfirmOpen(true)}>
              Propose handover
            </Button>
          </div>
        )}

        {!isOwner && !pending && (
          <p className="text-sm text-muted-foreground border-t pt-6">
            Only the current owner can hand the institution over.
          </p>
        )}
      </CardContent>

      <AlertDialog open={confirmOpen} onOpenChange={setConfirmOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Hand over ownership?</AlertDialogTitle>
            <AlertDialogDescription>
              {candidates.find((c) => c.user_id === selected)?.label} will be asked to accept. Once
              they accept, they control this institution and you become a normal member with only
              your Access Group's permissions.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Keep ownership</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => {
                setConfirmOpen(false);
                propose();
              }}
            >
              Propose handover
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </Card>
  );
}
