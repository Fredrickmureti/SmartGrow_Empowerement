/**
 * AuthorityPicker — bound to `public.legal_order_authorities`.
 *
 * Replaces the legacy free-text `issuing_authority` input on the legal-order
 * form. The picker returns an `authority_id` (canonical) plus a fallback
 * `authority_text` for jurisdictions where the authority is not yet
 * curated. Admins/owners can register a new authority inline.
 */
import { useMemo, useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { useOrganization } from "@/hooks/useOrganization";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { toast } from "sonner";
import { Plus } from "lucide-react";
import { normalizeError } from "@/services/resilience";

export interface AuthorityRow {
  id: string;
  code: string;
  name: string;
  authority_type: string | null;
  jurisdiction_country: string | null;
  jurisdiction_region: string | null;
  default_payee_bank: string | null;
  default_payee_account: string | null;
  default_payee_reference_template: string | null;
  remittance_schedule_ref: string | null;
  is_active: boolean;
}

interface Props {
  value: string | null;                       // authority_id
  fallbackText: string;                       // issuing_authority (free text)
  onChange: (v: { authority_id: string | null; authority_text: string; picked?: AuthorityRow | null }) => void;
  disabled?: boolean;
}

export function AuthorityPicker({ value, fallbackText, onChange, disabled }: Props) {
  const { currentOrg: organization } = useOrganization();
  const qc = useQueryClient();
  const [addOpen, setAddOpen] = useState(false);
  const [draft, setDraft] = useState({
    code: "",
    name: "",
    authority_type: "court",
    jurisdiction_country: "",
    jurisdiction_region: "",
  });

  const { data: authorities = [], isLoading } = useQuery<AuthorityRow[]>({
    queryKey: ["legal_order_authorities", organization?.id],
    enabled: !!organization?.id,
    queryFn: async () => {
      const { data, error } = await supabase
        .from("legal_order_authorities")
        .select("id, code, name, authority_type, jurisdiction_country, jurisdiction_region, default_payee_bank, default_payee_account, default_payee_reference_template, remittance_schedule_ref, is_active")
        .eq("organization_id", organization!.id)
        .eq("is_active", true)
        .order("name", { ascending: true });
      if (error) throw error;
      return (data ?? []) as AuthorityRow[];
    },
  });

  const byId = useMemo(() => new Map(authorities.map((a) => [a.id, a])), [authorities]);

  const create = useMutation({
    mutationFn: async () => {
      if (!organization?.id) throw new Error("No organization");
      if (!draft.code.trim() || !draft.name.trim()) throw new Error("Code and name are required");
      const { data, error } = await supabase
        .from("legal_order_authorities")
        .insert({
          organization_id: organization.id,
          code: draft.code.trim(),
          name: draft.name.trim(),
          authority_type: draft.authority_type || null,
          jurisdiction_country: draft.jurisdiction_country.trim() || null,
          jurisdiction_region: draft.jurisdiction_region.trim() || null,
          is_active: true,
        })
        .select("id, code, name, authority_type, jurisdiction_country, jurisdiction_region, default_payee_bank, default_payee_account, default_payee_reference_template, remittance_schedule_ref, is_active")
        .single();
      if (error) throw error;
      return data as AuthorityRow;
    },
    onSuccess: (row) => {
      qc.invalidateQueries({ queryKey: ["legal_order_authorities"] });
      onChange({ authority_id: row.id, authority_text: row.name, picked: row });
      setAddOpen(false);
      setDraft({ code: "", name: "", authority_type: "court", jurisdiction_country: "", jurisdiction_region: "" });
      toast.success(`Authority "${row.name}" registered`);
    },
    onError: (e: any) => toast.error(normalizeError(e).message),
  });

  return (
    <div className="space-y-2">
      <div className="flex items-center gap-2">
        <Select
          value={value ?? "__free__"}
          onValueChange={(v) => {
            if (v === "__free__") {
              onChange({ authority_id: null, authority_text: fallbackText, picked: null });
            } else {
              const row = byId.get(v) ?? null;
              onChange({ authority_id: v, authority_text: row?.name ?? "", picked: row });
            }
          }}
          disabled={disabled}
        >
          <SelectTrigger className="flex-1">
            <SelectValue placeholder={isLoading ? "Loading…" : "Select issuing authority"} />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="__free__">— Free text (unmapped) —</SelectItem>
            {authorities.map((a) => (
              <SelectItem key={a.id} value={a.id}>
                {a.name}
                {a.jurisdiction_country ? ` · ${a.jurisdiction_country}${a.jurisdiction_region ? "/" + a.jurisdiction_region : ""}` : ""}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>

        <Popover open={addOpen} onOpenChange={setAddOpen}>
          <PopoverTrigger asChild>
            <Button type="button" size="icon" variant="outline" disabled={disabled} title="Register a new authority">
              <Plus className="h-4 w-4" />
            </Button>
          </PopoverTrigger>
          <PopoverContent className="w-96 space-y-3">
            <div>
              <Label className="text-xs">Code</Label>
              <Input value={draft.code} onChange={(e) => setDraft({ ...draft, code: e.target.value })} placeholder="e.g. KE-CIV-COURT-NRB" />
            </div>
            <div>
              <Label className="text-xs">Name</Label>
              <Input value={draft.name} onChange={(e) => setDraft({ ...draft, name: e.target.value })} placeholder="Nairobi Civil Court" />
            </div>
            <div className="grid grid-cols-2 gap-2">
              <div>
                <Label className="text-xs">Country</Label>
                <Input value={draft.jurisdiction_country} onChange={(e) => setDraft({ ...draft, jurisdiction_country: e.target.value })} placeholder="KE" />
              </div>
              <div>
                <Label className="text-xs">Region</Label>
                <Input value={draft.jurisdiction_region} onChange={(e) => setDraft({ ...draft, jurisdiction_region: e.target.value })} placeholder="Nairobi" />
              </div>
            </div>
            <div>
              <Label className="text-xs">Type</Label>
              <Select value={draft.authority_type} onValueChange={(v) => setDraft({ ...draft, authority_type: v })}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="court">Court</SelectItem>
                  <SelectItem value="tax">Tax authority</SelectItem>
                  <SelectItem value="agency">Government agency</SelectItem>
                  <SelectItem value="creditor">Creditor</SelectItem>
                  <SelectItem value="other">Other</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div className="flex justify-end gap-2">
              <Button type="button" size="sm" variant="ghost" onClick={() => setAddOpen(false)}>Cancel</Button>
              <Button type="button" size="sm" onClick={() => create.mutate()} disabled={create.isPending}>
                {create.isPending ? "Registering…" : "Register"}
              </Button>
            </div>
          </PopoverContent>
        </Popover>
      </div>

      {!value && (
        <Input
          value={fallbackText}
          onChange={(e) => onChange({ authority_id: null, authority_text: e.target.value, picked: null })}
          placeholder="Or type the issuing authority (unmapped)"
          disabled={disabled}
        />
      )}
    </div>
  );
}
