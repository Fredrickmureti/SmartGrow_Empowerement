import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useOrganization } from "@/hooks/useOrganization";
import { supabase } from "@/integrations/supabase/client";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import { Label } from "@/components/ui/label";
import { Loader2, ShieldCheck, Users, Lock } from "lucide-react";
import { useToast } from "@/hooks/use-toast";

type Mode = "solo" | "standard" | "strict";

interface ModeOption {
  value: Mode;
  icon: typeof ShieldCheck;
  title: string;
  blurb: string;
  details: string;
}

const OPTIONS: ModeOption[] = [
  {
    value: "solo",
    icon: ShieldCheck,
    title: "Solo",
    blurb: "You're the only user — approve your own work without friction.",
    details:
      "While the organization has one active member, self-approval is auto-allowed (each event is still recorded in the audit log). Adding a second teammate automatically upgrades to Standard.",
  },
  {
    value: "standard",
    icon: Users,
    title: "Standard",
    blurb: "Recommended for most teams. Owners can self-approve, staff cannot.",
    details:
      "Owners and super admins can approve their own records (warn + audit). Admins and below must hand off approval to a separate approver. Matches how Xero, QuickBooks, and NetSuite ship to small teams.",
  },
  {
    value: "strict",
    icon: Lock,
    title: "Strict",
    blurb: "Full segregation of duties. Nobody approves their own work.",
    details:
      "Every user — including the owner — must hand approval to a different person. A one-time co-signed override is still available for genuine exceptions. Use this for SOX-style controls or once your finance team has full coverage.",
  },
];

export function GovernanceModeCard() {
  const { currentOrg } = useOrganization();
  const orgId = currentOrg?.id ?? null;
  const queryClient = useQueryClient();
  const { toast } = useToast();

  const { data, isLoading } = useQuery({
    queryKey: ["org-governance-mode", orgId],
    enabled: !!orgId,
    queryFn: async () => {
      const { data, error } = await supabase
        .from("organizations")
        .select("governance_mode")
        .eq("id", orgId!)
        .single();
      if (error) throw error;
      return data as { governance_mode: Mode };
    },
  });

  const { data: memberCount } = useQuery({
    queryKey: ["org-member-count", orgId],
    enabled: !!orgId,
    queryFn: async () => {
      const { count, error } = await supabase
        .from("user_roles")
        .select("user_id", { count: "exact", head: true })
        .eq("organization_id", orgId!)
        .eq("is_active", true);
      if (error) throw error;
      return count ?? 0;
    },
  });

  const update = useMutation({
    mutationFn: async (mode: Mode) => {
      if (!orgId) throw new Error("No organization");
      const { error } = await supabase
        .from("organizations")
        .update({ governance_mode: mode } as never)
        .eq("id", orgId);
      if (error) throw error;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["org-governance-mode", orgId] });
      toast({ title: "Governance mode updated" });
    },
    onError: (e: unknown) => {
      toast({
        title: "Could not update mode",
        description: e instanceof Error ? e.message : String(e),
        variant: "destructive",
      });
    },
  });

  if (!orgId) return null;
  const current = data?.governance_mode ?? "solo";

  return (
    <Card>
      <CardHeader>
        <div className="flex items-start justify-between gap-3">
          <div>
            <CardTitle className="flex items-center gap-2">
              <ShieldCheck className="h-5 w-5" />
              Governance mode
            </CardTitle>
            <CardDescription>
              Choose how strictly the platform enforces segregation of duties. You can fine-tune
              individual actions in the Advanced section below.
            </CardDescription>
          </div>
          {typeof memberCount === "number" && (
            <Badge variant="outline">
              {memberCount} active member{memberCount === 1 ? "" : "s"}
            </Badge>
          )}
        </div>
      </CardHeader>
      <CardContent>
        {isLoading ? (
          <div className="flex items-center justify-center py-6">
            <Loader2 className="h-5 w-5 animate-spin" />
          </div>
        ) : (
          <RadioGroup
            value={current}
            onValueChange={(v) => update.mutate(v as Mode)}
            className="grid gap-3 md:grid-cols-3"
          >
            {OPTIONS.map((opt) => {
              const Icon = opt.icon;
              const selected = current === opt.value;
              return (
                <label
                  key={opt.value}
                  htmlFor={`gov-mode-${opt.value}`}
                  className={`relative cursor-pointer rounded-lg border p-4 transition ${
                    selected ? "border-primary ring-2 ring-primary/30" : "hover:border-foreground/30"
                  }`}
                >
                  <RadioGroupItem
                    id={`gov-mode-${opt.value}`}
                    value={opt.value}
                    className="sr-only"
                  />
                  <div className="flex items-center gap-2 mb-2">
                    <Icon className="h-4 w-4" />
                    <span className="font-semibold">{opt.title}</span>
                    {selected && <Badge className="ml-auto">Current</Badge>}
                  </div>
                  <p className="text-sm">{opt.blurb}</p>
                  <p className="text-xs text-muted-foreground mt-2">{opt.details}</p>
                </label>
              );
            })}
          </RadioGroup>
        )}
        <p className="text-xs text-muted-foreground mt-4">
          The mode sets the default for every sensitive action. Any individual override you save
          below always wins over the mode default.
        </p>
      </CardContent>
    </Card>
  );
}