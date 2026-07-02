import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { DetailSheet } from "@/design-system/primitives/DetailSheet";
import { FooterActionBar } from "@/design-system/primitives/FooterActionBar";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Separator } from "@/components/ui/separator";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  CheckCircle2,
  AlertTriangle,
  XCircle,
  Sparkles,
  Loader2,
  Lock,
  Plus,
} from "lucide-react";
import { toast } from "sonner";
import { normalizeError } from "@/services/resilience";

type Confidence = "exact" | "strong" | "weak" | "none";
type ProposalStatus =
  | "auto_mapped"
  | "ambiguous"
  | "missing"
  | "preserved";

interface ScoredCandidate {
  account: {
    id: string;
    code: string;
    name: string;
    account_type: string;
    detail_type: string | null;
  };
  score: number;
  confidence: Confidence;
  eligible: boolean;
  reasons: string[];
}

interface RoleProposal {
  role: {
    role_key: string;
    label: string;
    description: string;
    required_account_type: string;
    is_mandatory: boolean;
    category: string;
    sort_order: number;
  };
  status: ProposalStatus;
  selected: ScoredCandidate | null;
  alternatives: ScoredCandidate[];
  current_account_id: string | null;
  message: string;
}

interface PreviewResponse {
  proposals: RoleProposal[];
  summary: {
    total: number;
    auto_mapped: number;
    preserved: number;
    ambiguous: number;
    missing: number;
    mandatory_missing: number;
  };
  generated_at: string;
}

interface ApplyDefaultMappingsDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  organizationId: string;
  businessId: string;
  onApplied?: () => void;
}

const STATUS_META: Record<
  ProposalStatus,
  { label: string; icon: React.ComponentType<{ className?: string }>; tone: string }
> = {
  auto_mapped: { label: "Auto-map", icon: Sparkles, tone: "text-primary" },
  preserved:   { label: "Preserved", icon: Lock, tone: "text-muted-foreground" },
  ambiguous:   { label: "Pick one",  icon: AlertTriangle, tone: "text-amber-500" },
  missing:     { label: "Missing",   icon: XCircle, tone: "text-destructive" },
};

const CONFIDENCE_TONE: Record<Confidence, string> = {
  exact: "bg-primary/10 text-primary",
  strong: "bg-primary/10 text-primary",
  weak: "bg-amber-500/10 text-amber-700 dark:text-amber-400",
  none: "bg-muted text-muted-foreground",
};

export function ApplyDefaultMappingsDialog({
  open,
  onOpenChange,
  organizationId,
  businessId,
  onApplied,
}: ApplyDefaultMappingsDialogProps) {
  const qc = useQueryClient();
  const [overrides, setOverrides] = useState<Record<string, string>>({});

  const previewQ = useQuery<PreviewResponse>({
    queryKey: ["mapping-preview", organizationId, businessId, open],
    enabled: open && !!organizationId && !!businessId,
    queryFn: async () => {
      const { data, error } = await supabase.functions.invoke<PreviewResponse>(
        "preview-default-mappings",
        { body: { organization_id: organizationId, business_id: businessId } },
      );
      if (error) throw error;
      if (!data) throw new Error("Empty preview response");
      return data;
    },
  });

  const applyM = useMutation({
    mutationFn: async (selections: Record<string, string>) => {
      const { data, error } = await supabase.functions.invoke<{
        batch_id: string;
        committed: number;
        skipped: { role_key: string; reason: string }[];
      }>("apply-default-mappings", {
        body: {
          organization_id: organizationId,
          business_id: businessId,
          selections,
        },
      });
      if (error) throw error;
      return data!;
    },
    onSuccess: (res) => {
      toast.success(
        `Applied ${res.committed} mapping${res.committed === 1 ? "" : "s"}` +
          (res.skipped.length ? ` · ${res.skipped.length} skipped` : ""),
      );
      qc.invalidateQueries({ queryKey: ["default-accounts"] });
      qc.invalidateQueries({ queryKey: ["mapping-preview"] });
      onApplied?.();
      onOpenChange(false);
    },
    onError: (err: any) => {
      toast.error(normalizeError(err).message ?? "Failed to apply mappings");
    },
  });

  const provisionM = useMutation({
    mutationFn: async (roleKey: string) => {
      const { data, error } = await supabase.rpc("provision_system_account", {
        _role_key: roleKey,
        _organization_id: organizationId,
        _business_id: businessId,
      });
      if (error) throw error;
      return data;
    },
    onSuccess: (_d, roleKey) => {
      toast.success(`Created suggested account for "${roleKey}"`);
      qc.invalidateQueries({ queryKey: ["mapping-preview"] });
      qc.invalidateQueries({ queryKey: ["accounts"] });
      previewQ.refetch();
    },
    onError: (err: any) => {
      toast.error(normalizeError(err).message ?? "Failed to create account");
    },
  });

  const provisionAllM = useMutation({
    mutationFn: async () => {
      const { data, error } = await supabase.rpc(
        "provision_missing_system_accounts",
        {
          _organization_id: organizationId,
          _business_id: businessId,
          _mandatory_only: false,
        },
      );
      if (error) throw error;
      return data as Array<{ role_key: string; account_id: string | null; status: string }>;
    },
    onSuccess: (rows) => {
      const created = rows.filter((r) => r.status === "provisioned").length;
      toast.success(
        created > 0
          ? `Created ${created} suggested account${created === 1 ? "" : "s"}`
          : "All roles already have eligible accounts",
      );
      qc.invalidateQueries({ queryKey: ["mapping-preview"] });
      qc.invalidateQueries({ queryKey: ["accounts"] });
      previewQ.refetch();
    },
    onError: (err: any) => {
      toast.error(normalizeError(err).message ?? "Failed to provision accounts");
    },
  });

  const proposals = previewQ.data?.proposals ?? [];
  const summary = previewQ.data?.summary;
  const ambiguous = proposals.filter((p) => p.status === "ambiguous");

  const handleApply = async () => {
    // Chain: if anything is missing, auto-provision first then re-fetch the
    // preview before committing — so a fresh tenant doesn't have to click
    // "Create all missing" separately. Mirrors QuickBooks "Set up defaults".
    if (summary && summary.missing > 0) {
      try {
        await provisionAllM.mutateAsync();
        await previewQ.refetch();
      } catch {
        // toast already shown by provisionAllM.onError
        return;
      }
    }
    applyM.mutate(overrides);
  };

  return (
    <DetailSheet
      open={open}
      onOpenChange={onOpenChange}
      size="xl"
      title={
        <span className="flex items-center gap-2">
          <Sparkles className="h-5 w-5 text-primary" />
          Apply Default Account Mapping
        </span>
      }
      description="Review the engine's deterministic proposal before committing. Each role is matched against eligible accounts only — no guesswork. Existing valid mappings are preserved automatically."
      footer={
        <FooterActionBar
          anchor="sheet"
          leading={
            <Button variant="ghost" onClick={() => onOpenChange(false)} disabled={applyM.isPending}>
              Cancel
            </Button>
          }
          trailing={
            <Button onClick={handleApply} disabled={applyM.isPending || previewQ.isLoading || !!previewQ.error}>
              {applyM.isPending ? (
                <><Loader2 className="h-4 w-4 mr-2 animate-spin" /> Applying…</>
              ) : (
                <><CheckCircle2 className="h-4 w-4 mr-2" /> Apply mappings</>
              )}
            </Button>
          }
        />
      }
    >


        {previewQ.isLoading && (
          <div className="flex items-center justify-center py-12">
            <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
          </div>
        )}

        {previewQ.error && (
          <Alert variant="destructive">
            <AlertTriangle className="h-4 w-4" />
            <AlertDescription>{(previewQ.error as Error).message}</AlertDescription>
          </Alert>
        )}

        {summary && (
          <div className="flex flex-wrap gap-2">
            <Badge variant="secondary" className="gap-1">
              <Sparkles className="h-3 w-3" /> Auto-map: {summary.auto_mapped}
            </Badge>
            <Badge variant="outline" className="gap-1">
              <Lock className="h-3 w-3" /> Preserved: {summary.preserved}
            </Badge>
            <Badge
              variant="outline"
              className="gap-1 border-amber-500/50 text-amber-600 dark:text-amber-400"
            >
              <AlertTriangle className="h-3 w-3" /> Pick one: {summary.ambiguous}
            </Badge>
            <Badge
              variant={summary.mandatory_missing > 0 ? "destructive" : "outline"}
              className="gap-1"
            >
              <XCircle className="h-3 w-3" /> Missing: {summary.missing}
              {summary.mandatory_missing > 0 &&
                ` (${summary.mandatory_missing} mandatory)`}
            </Badge>
          </div>
        )}

        {summary?.mandatory_missing ? (
          <Alert variant="destructive">
            <AlertTriangle className="h-4 w-4" />
            <AlertDescription>
              {summary.mandatory_missing} mandatory role
              {summary.mandatory_missing === 1 ? "" : "s"} cannot be auto-mapped
              because no eligible account exists. Create the missing accounts in
              your Chart of Accounts (with the correct detail type) before
              applying.
            </AlertDescription>
          </Alert>
        ) : null}

        {ambiguous.length > 0 && (
          <Alert>
            <AlertTriangle className="h-4 w-4" />
            <AlertDescription>
              {ambiguous.length} role{ambiguous.length === 1 ? " has" : "s have"} multiple
              eligible candidates. Pick one below — nothing will be saved without
              confirmation.
            </AlertDescription>
          </Alert>
        )}

        {proposals.some((p) => p.status === "missing") && (
          <div className="flex items-center justify-between rounded-md border border-dashed border-amber-500/40 bg-amber-500/5 p-2">
            <p className="text-xs text-muted-foreground">
              Some roles have no eligible account in your Chart of Accounts. You can
              auto-create them from the system template.
            </p>
            <Button
              size="sm"
              variant="outline"
              onClick={() => provisionAllM.mutate()}
              disabled={provisionAllM.isPending}
            >
              {provisionAllM.isPending ? (
                <Loader2 className="h-3 w-3 mr-1 animate-spin" />
              ) : (
                <Plus className="h-3 w-3 mr-1" />
              )}
              Create all missing
            </Button>
          </div>
        )}

        <ScrollArea className="max-h-[55vh] pr-3">
          <div className="space-y-3">
            {proposals.map((p) => (
              <ProposalRow
                key={p.role.role_key}
                proposal={p}
                override={overrides[p.role.role_key]}
                onOverride={(id) =>
                  setOverrides((prev) => ({ ...prev, [p.role.role_key]: id }))
                }
                onProvision={() => provisionM.mutate(p.role.role_key)}
                provisioning={
                  provisionM.isPending && provisionM.variables === p.role.role_key
                }
              />
            ))}
          </div>
        </ScrollArea>
    </DetailSheet>

  );
}

function ProposalRow({
  proposal,
  override,
  onOverride,
  onProvision,
  provisioning,
}: {
  proposal: RoleProposal;
  override?: string;
  onOverride: (id: string) => void;
  onProvision?: () => void;
  provisioning?: boolean;
}) {
  const StatusIcon = STATUS_META[proposal.status].icon;
  const tone = STATUS_META[proposal.status].tone;
  const selectedId = override || proposal.selected?.account.id || "";

  // The engine assigns a real per-candidate confidence to every ranked
  // alternative (not just the winner). The badge below is therefore a true
  // reflection of the SELECTED account's relative strength — picking a
  // runner-up will reveal its actual confidence rather than masquerading as
  // the engine's pick. We do NOT auto-promote overrides to "strong"; that
  // hides ambiguity. The "User-confirmed" pill makes the override explicit.
  const engineSelectedId = proposal.selected?.account.id ?? null;
  const activeCandidate =
    proposal.alternatives.find((a) => a.account.id === selectedId) ??
    proposal.selected ??
    null;
  const isUserOverride =
    !!override && !!engineSelectedId && override !== engineSelectedId;
  const effectiveConfidence: Confidence = activeCandidate
    ? activeCandidate.confidence
    : "none";

  return (
    <div className="rounded-md border border-border/60 bg-card p-3 space-y-2">
      <div className="flex items-start gap-2">
        <StatusIcon className={`h-4 w-4 mt-0.5 ${tone}`} />
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 flex-wrap">
            <span className="font-medium text-sm">{proposal.role.label}</span>
            {proposal.role.is_mandatory && (
              <Badge variant="outline" className="text-[10px]">Mandatory</Badge>
            )}
            <Badge variant="secondary" className="text-[10px] uppercase">
              {proposal.role.required_account_type}
            </Badge>
            <Badge variant="outline" className="text-[10px]">
              {STATUS_META[proposal.status].label}
            </Badge>
            {activeCandidate && (
              <Badge
                className={`text-[10px] ${CONFIDENCE_TONE[effectiveConfidence]}`}
              >
                {effectiveConfidence}
              </Badge>
            )}
            {isUserOverride && (
              <Badge variant="outline" className="text-[10px]">
                User-confirmed
              </Badge>
            )}
          </div>
          <p className="text-xs text-muted-foreground mt-0.5">
            {proposal.message}
          </p>
        </div>
      </div>

      {proposal.alternatives.length > 0 ? (
        <Select value={selectedId} onValueChange={onOverride}>
          <SelectTrigger className="h-9 text-xs">
            <SelectValue placeholder="Select an account" />
          </SelectTrigger>
          <SelectContent>
            {proposal.alternatives.map((alt) => (
              <SelectItem key={alt.account.id} value={alt.account.id}>
                <span className="font-mono mr-2">{alt.account.code}</span>
                {alt.account.name}
                <span className="text-muted-foreground ml-2 text-[10px]">
                  · {alt.confidence} · score {Math.round(alt.score)}
                </span>
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      ) : (
        <div className="flex items-center justify-between gap-2">
          <p className="text-xs text-destructive">
            No eligible account in your Chart of Accounts for this role.
          </p>
          {onProvision && (
            <Button
              size="sm"
              variant="outline"
              onClick={onProvision}
              disabled={provisioning}
            >
              {provisioning ? (
                <Loader2 className="h-3 w-3 mr-1 animate-spin" />
              ) : (
                <Plus className="h-3 w-3 mr-1" />
              )}
              Create suggested account
            </Button>
          )}
        </div>
      )}

      {proposal.selected?.reasons?.length ? (
        <ul className="text-[11px] text-muted-foreground list-disc pl-4 space-y-0.5">
          {proposal.selected.reasons.slice(0, 3).map((r, i) => (
            <li key={i}>{r}</li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}