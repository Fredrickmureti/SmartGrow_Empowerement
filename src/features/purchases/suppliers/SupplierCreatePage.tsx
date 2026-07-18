/**
 * SupplierCreatePage — create a new supplier record.
 *
 * Two-step wire:
 *   1. Insert a `contacts` row typed as supplier (organization + business
 *      scoped) so RLS + existing contact tooling continue to work.
 *   2. Insert the canonical `suppliers` row referencing the new contact.
 *
 * The two-step is deliberate: `contacts` remains the identity/address
 * store shared with Sales, while `suppliers` is the procurement master
 * record with lifecycle + qualification metadata (P1).
 *
 * When P11 workbench cutover retires the legacy vendor CRUD, this
 * page becomes the only entry point for creating a supplier.
 */
import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { ArrowLeft } from "lucide-react";

import {
  PageBody,
  PageHeader,
  ActionBar,
  Section,
} from "@/design-system";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { useToast } from "@/hooks/use-toast";
import { supabase } from "@/integrations/supabase/client";
import { useOrganization } from "@/contexts/OrganizationContext";
import { useBusinesses } from "@/contexts/BusinessContext";
import { useSupplierCategories } from "./useSuppliers";

export default function SupplierCreatePage() {
  const navigate = useNavigate();
  const { toast } = useToast();
  const { currentOrg } = useOrganization();
  const { currentBusiness } = useBusinesses();
  const categories = useSupplierCategories();

  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [phone, setPhone] = useState("");
  const [taxId, setTaxId] = useState("");
  const [code, setCode] = useState("");
  const [categoryId, setCategoryId] = useState<string>("");
  const [currency, setCurrency] = useState("");
  const [incoterms, setIncoterms] = useState("");
  const [leadTime, setLeadTime] = useState<string>("");
  const [notes, setNotes] = useState("");
  const [busy, setBusy] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!currentOrg || !currentBusiness) {
      toast({
        title: "No workspace selected",
        description: "Pick a company before creating a supplier.",
        variant: "destructive",
      });
      return;
    }
    if (!name.trim()) {
      toast({ title: "Name is required", variant: "destructive" });
      return;
    }
    setBusy(true);
    try {
      const { data: contact, error: cErr } = await (supabase as any)
        .from("contacts")
        .insert({
          organization_id: currentOrg.id,
          business_id: currentBusiness.id,
          type: "supplier",
          name: name.trim(),
          email: email.trim() || null,
          phone: phone.trim() || null,
          tax_id: taxId.trim() || null,
          notes: notes.trim() || null,
          supplier_rank: 1,
        })
        .select("id")
        .single();
      if (cErr) throw cErr;

      const { data: supplier, error: sErr } = await (supabase as any)
        .from("suppliers")
        .insert({
          organization_id: currentOrg.id,
          business_id: currentBusiness.id,
          contact_id: contact.id,
          category_id: categoryId || null,
          supplier_code: code.trim() || null,
          lifecycle_state: "prospect",
          default_currency: currency.trim() || null,
          default_incoterms: incoterms.trim() || null,
          default_lead_time_days: leadTime ? Number(leadTime) : null,
        })
        .select("id")
        .single();
      if (sErr) throw sErr;

      toast({ title: "Supplier created", description: name.trim() });
      navigate(`/purchases/suppliers/${supplier.id}`);
    } catch (err: any) {
      toast({
        title: "Failed to create supplier",
        description: err?.message ?? String(err),
        variant: "destructive",
      });
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <PageHeader
        eyebrow="Suppliers"
        title="New supplier"
        description="Create the identity + procurement master record. Qualification starts once the supplier is submitted."
        actions={
          <ActionBar>
            <Button
              variant="outline"
              size="sm"
              onClick={() => navigate("/purchases/suppliers")}
            >
              <ArrowLeft className="mr-2 h-4 w-4" /> Back
            </Button>
          </ActionBar>
        }
      />
      <PageBody>
        <form onSubmit={submit} className="space-y-6 max-w-3xl">
          <Section title="Identity">
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
              <div className="sm:col-span-2">
                <Label htmlFor="name">Legal name *</Label>
                <Input
                  id="name"
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  required
                />
              </div>
              <div>
                <Label htmlFor="email">Email</Label>
                <Input
                  id="email"
                  type="email"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                />
              </div>
              <div>
                <Label htmlFor="phone">Phone</Label>
                <Input
                  id="phone"
                  value={phone}
                  onChange={(e) => setPhone(e.target.value)}
                />
              </div>
              <div>
                <Label htmlFor="tax">Tax ID</Label>
                <Input
                  id="tax"
                  value={taxId}
                  onChange={(e) => setTaxId(e.target.value)}
                />
              </div>
              <div>
                <Label htmlFor="code">Supplier code</Label>
                <Input
                  id="code"
                  value={code}
                  onChange={(e) => setCode(e.target.value)}
                />
              </div>
            </div>
          </Section>

          <Section title="Procurement defaults">
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
              <div>
                <Label htmlFor="cat">Category</Label>
                <select
                  id="cat"
                  value={categoryId}
                  onChange={(e) => setCategoryId(e.target.value)}
                  className="mt-1 flex h-10 w-full rounded-md border border-input bg-background px-3 text-sm"
                >
                  <option value="">— None —</option>
                  {categories.map((c) => (
                    <option key={c.id} value={c.id}>
                      {c.name}
                    </option>
                  ))}
                </select>
              </div>
              <div>
                <Label htmlFor="cur">Default currency</Label>
                <Input
                  id="cur"
                  placeholder="USD"
                  value={currency}
                  onChange={(e) => setCurrency(e.target.value.toUpperCase())}
                  maxLength={3}
                />
              </div>
              <div>
                <Label htmlFor="inco">Default incoterms</Label>
                <Input
                  id="inco"
                  placeholder="EXW, FOB, DAP…"
                  value={incoterms}
                  onChange={(e) => setIncoterms(e.target.value.toUpperCase())}
                />
              </div>
              <div>
                <Label htmlFor="lead">Default lead time (days)</Label>
                <Input
                  id="lead"
                  type="number"
                  min={0}
                  value={leadTime}
                  onChange={(e) => setLeadTime(e.target.value)}
                />
              </div>
            </div>
          </Section>

          <Section title="Notes">
            <Textarea
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              rows={4}
            />
          </Section>

          <div className="flex justify-end gap-2">
            <Button
              type="button"
              variant="outline"
              onClick={() => navigate("/purchases/suppliers")}
            >
              Cancel
            </Button>
            <Button type="submit" disabled={busy}>
              {busy ? "Creating…" : "Create supplier"}
            </Button>
          </div>
        </form>
      </PageBody>
    </>
  );
}
