/**
 * AuthorityPicker — canonical master-data writer (ADR-0093).
 *
 * Reads the curated authority list from `legal_order_authorities`, the
 * single source of truth for issuing bodies (courts, tax agencies,
 * child-support offices, labor ministries). At install time R5 seeds
 * this table from the localization pack's `statutory_authorities`, so
 * tenants land with the jurisdiction pre-loaded.
 *
 * Inline "Register new authority" calls `party_upsert_authority_from_form`,
 * which creates the backing Contact and upserts the
 * `legal_order_authorities` row atomically.
 *
 * Emits `{ authority_id }` on selection. Callers stamp only `authority_id`
 * on `legal_orders_records`. The retired overlay column
 * `authority_contact_id` and the payee snapshot columns
 * (payee_name/bank/account/reference) are gone — recipient identity, bank
 * details, and remittance reference live on `legal_recipients`.
 */

import { useMemo, useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { useOrganization } from "@/hooks/useOrganization";
import { useBusinesses } from "@/hooks/useBusinesses";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetFooter,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
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
  contact_id: string | null;
  is_active: boolean;
}

interface Props {
  value: string | null; // authority_id (legacy pk, still used by legal_orders_records.authority_id)
  fallbackText: string;
  onChange: (v: {
    authority_id: string | null;
    authority_text: string;
    picked?: AuthorityRow | null;
  }) => void;
  disabled?: boolean;
}

const emptyDraft = {
  // Contact identity
  name: "",
  is_company: true,
  email: "",
  phone: "",
  address_line1: "",
  city: "",
  state: "",
  postal_code: "",
  country: "",
  tax_id: "",
  notes: "",
  // Authority profile
  authority_type: "court",
  code: "",
  jurisdiction_country: "",
  jurisdiction_region: "",
  statutory_id: "",
  default_payee_bank: "",
  default_payee_account: "",
  default_payee_reference_template: "",
  remittance_schedule_ref: "",
};

export function AuthorityPicker({ value, fallbackText, onChange, disabled }: Props) {
  const { currentOrg: organization } = useOrganization();
  const { currentBusiness } = useBusinesses();
  const qc = useQueryClient();
  const [addOpen, setAddOpen] = useState(false);
  const [draft, setDraft] = useState(emptyDraft);

  const { data: authorities = [], isLoading } = useQuery<AuthorityRow[]>({
    queryKey: ["legal_order_authorities", organization?.id],
    enabled: !!organization?.id,
    queryFn: async () => {
      const { data, error } = await supabase
        .from("legal_order_authorities")
        .select(
          "id, code, name, authority_type, jurisdiction_country, jurisdiction_region, default_payee_bank, default_payee_account, default_payee_reference_template, remittance_schedule_ref, contact_id, is_active",
        )
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
      if (!draft.name.trim()) throw new Error("Name is required");
      const { data, error } = await (supabase as any).rpc(
        "party_upsert_authority_from_form",
        {
          p_organization_id: organization.id,
          p_business_id: currentBusiness?.id ?? null,
          p_contact_id: null,
          p_name: draft.name.trim(),
          p_is_company: draft.is_company,
          p_email: draft.email.trim() || null,
          p_phone: draft.phone.trim() || null,
          p_address_line1: draft.address_line1.trim() || null,
          p_city: draft.city.trim() || null,
          p_state: draft.state.trim() || null,
          p_postal_code: draft.postal_code.trim() || null,
          p_country: draft.country.trim() || null,
          p_tax_id: draft.tax_id.trim() || null,
          p_notes: draft.notes.trim() || null,
          p_authority_type: draft.authority_type || "court",
          p_code: draft.code.trim() || null,
          p_jurisdiction_country: draft.jurisdiction_country.trim() || null,
          p_jurisdiction_region: draft.jurisdiction_region.trim() || null,
          p_statutory_id: draft.statutory_id.trim() || null,
          p_default_payee_bank: draft.default_payee_bank.trim() || null,
          p_default_payee_account: draft.default_payee_account.trim() || null,
          p_default_payee_reference_template:
            draft.default_payee_reference_template.trim() || null,
          p_remittance_schedule_ref: draft.remittance_schedule_ref.trim() || null,
          p_metadata: {},
        },
      );
      if (error) throw error;
      return data as { contact_id: string; authority_id: string };
    },
    onSuccess: async (res) => {
      await qc.invalidateQueries({ queryKey: ["legal_order_authorities"] });
      onChange({
        authority_id: res.authority_id,
        authority_text: draft.name.trim(),
      });
      setAddOpen(false);
      setDraft(emptyDraft);
      toast.success(`Authority "${draft.name.trim()}" registered`);
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
              onChange({
                authority_id: null,
                authority_text: fallbackText,
                picked: null,
              });
            } else {
              const row = byId.get(v) ?? null;
              onChange({
                authority_id: v,
                authority_text: row?.name ?? "",
                picked: row,
              });
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
                {a.jurisdiction_country
                  ? ` · ${a.jurisdiction_country}${a.jurisdiction_region ? "/" + a.jurisdiction_region : ""}`
                  : ""}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>

        <Button
          type="button"
          size="icon"
          variant="outline"
          disabled={disabled}
          title="Register a new authority"
          onClick={() => setAddOpen(true)}
        >
          <Plus className="h-4 w-4" />
        </Button>
      </div>

      {!value && (
        <Input
          value={fallbackText}
          onChange={(e) =>
            onChange({
              authority_id: null,
              authority_text: e.target.value,
              picked: null,
            })
          }
          placeholder="Or type the issuing authority (unmapped)"
          disabled={disabled}
        />
      )}

      <Sheet open={addOpen} onOpenChange={setAddOpen}>
        <SheetContent side="right" className="w-full sm:max-w-xl overflow-y-auto">
          <SheetHeader>
            <SheetTitle>Register a new Issuing Authority</SheetTitle>
            <SheetDescription>
              Creates a Contact on the party spine (party-only — not a customer, not a
              vendor) and stamps its Authority role. Reusable across every garnishment
              in this organization.
            </SheetDescription>
          </SheetHeader>

          <div className="space-y-6 py-4">
            <section className="space-y-3">
              <h3 className="text-sm font-semibold">Identity</h3>
              <div>
                <Label>Legal name *</Label>
                <Input
                  value={draft.name}
                  onChange={(e) => setDraft({ ...draft, name: e.target.value })}
                  placeholder="Nairobi Family Court"
                />
              </div>
              <label className="flex items-center gap-2 text-sm">
                <Checkbox
                  checked={draft.is_company}
                  onCheckedChange={(v) => setDraft({ ...draft, is_company: v === true })}
                />
                <span>Organization (court, agency, tax authority, creditor firm)</span>
              </label>
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <Label>Email</Label>
                  <Input
                    type="email"
                    value={draft.email}
                    onChange={(e) => setDraft({ ...draft, email: e.target.value })}
                  />
                </div>
                <div>
                  <Label>Phone</Label>
                  <Input
                    value={draft.phone}
                    onChange={(e) => setDraft({ ...draft, phone: e.target.value })}
                  />
                </div>
              </div>
              <div>
                <Label>Statutory / registration identifier</Label>
                <Input
                  value={draft.tax_id}
                  onChange={(e) => setDraft({ ...draft, tax_id: e.target.value })}
                  placeholder="PIN, tax ID, registration number"
                />
              </div>
            </section>

            <section className="space-y-3">
              <h3 className="text-sm font-semibold">Address</h3>
              <div>
                <Label>Street</Label>
                <Input
                  value={draft.address_line1}
                  onChange={(e) => setDraft({ ...draft, address_line1: e.target.value })}
                />
              </div>
              <div className="grid grid-cols-3 gap-3">
                <div>
                  <Label>City</Label>
                  <Input
                    value={draft.city}
                    onChange={(e) => setDraft({ ...draft, city: e.target.value })}
                  />
                </div>
                <div>
                  <Label>State / region</Label>
                  <Input
                    value={draft.state}
                    onChange={(e) => setDraft({ ...draft, state: e.target.value })}
                  />
                </div>
                <div>
                  <Label>Postal code</Label>
                  <Input
                    value={draft.postal_code}
                    onChange={(e) => setDraft({ ...draft, postal_code: e.target.value })}
                  />
                </div>
              </div>
              <div>
                <Label>Country</Label>
                <Input
                  value={draft.country}
                  onChange={(e) => setDraft({ ...draft, country: e.target.value })}
                  placeholder="KE"
                />
              </div>
            </section>

            <section className="space-y-3">
              <h3 className="text-sm font-semibold">Authority profile</h3>
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <Label>Type</Label>
                  <Select
                    value={draft.authority_type}
                    onValueChange={(v) => setDraft({ ...draft, authority_type: v })}
                  >
                    <SelectTrigger>
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="court">Court</SelectItem>
                      <SelectItem value="tax">Tax authority</SelectItem>
                      <SelectItem value="agency">Government agency</SelectItem>
                      <SelectItem value="creditor">Creditor</SelectItem>
                      <SelectItem value="other">Other</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
                <div>
                  <Label>Internal code</Label>
                  <Input
                    value={draft.code}
                    onChange={(e) => setDraft({ ...draft, code: e.target.value })}
                    placeholder="Auto if blank"
                  />
                </div>
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <Label>Jurisdiction country</Label>
                  <Input
                    value={draft.jurisdiction_country}
                    onChange={(e) =>
                      setDraft({ ...draft, jurisdiction_country: e.target.value })
                    }
                    placeholder="KE"
                  />
                </div>
                <div>
                  <Label>Jurisdiction region</Label>
                  <Input
                    value={draft.jurisdiction_region}
                    onChange={(e) =>
                      setDraft({ ...draft, jurisdiction_region: e.target.value })
                    }
                    placeholder="Nairobi"
                  />
                </div>
              </div>
              <div>
                <Label>Court / agency reference (statutory ID)</Label>
                <Input
                  value={draft.statutory_id}
                  onChange={(e) => setDraft({ ...draft, statutory_id: e.target.value })}
                />
              </div>
            </section>

            <section className="space-y-3">
              <h3 className="text-sm font-semibold">Default remittance</h3>
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <Label>Bank</Label>
                  <Input
                    value={draft.default_payee_bank}
                    onChange={(e) =>
                      setDraft({ ...draft, default_payee_bank: e.target.value })
                    }
                  />
                </div>
                <div>
                  <Label>Account</Label>
                  <Input
                    value={draft.default_payee_account}
                    onChange={(e) =>
                      setDraft({ ...draft, default_payee_account: e.target.value })
                    }
                  />
                </div>
              </div>
              <div>
                <Label>Payment reference template</Label>
                <Input
                  value={draft.default_payee_reference_template}
                  onChange={(e) =>
                    setDraft({
                      ...draft,
                      default_payee_reference_template: e.target.value,
                    })
                  }
                  placeholder="e.g. {case_reference}/{employee_id}"
                />
              </div>
              <div>
                <Label>Remittance schedule</Label>
                <Input
                  value={draft.remittance_schedule_ref}
                  onChange={(e) =>
                    setDraft({ ...draft, remittance_schedule_ref: e.target.value })
                  }
                  placeholder="monthly, per_payment…"
                />
              </div>
            </section>

            <section className="space-y-2">
              <Label>Notes</Label>
              <Textarea
                rows={3}
                value={draft.notes}
                onChange={(e) => setDraft({ ...draft, notes: e.target.value })}
              />
            </section>
          </div>

          <SheetFooter>
            <Button variant="ghost" onClick={() => setAddOpen(false)}>
              Cancel
            </Button>
            <Button
              disabled={create.isPending || !draft.name.trim()}
              onClick={() => create.mutate()}
            >
              {create.isPending ? "Registering…" : "Register authority"}
            </Button>
          </SheetFooter>
        </SheetContent>
      </Sheet>
    </div>
  );
}
