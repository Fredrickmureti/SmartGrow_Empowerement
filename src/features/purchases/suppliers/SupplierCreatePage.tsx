/**
 * SupplierCreatePage — create a new supplier record.
 *
 * Server-authoritative: the page calls `create_supplier`, which writes the
 * party (`contacts`) and the procurement role (`suppliers`) in ONE
 * transaction. Per ADR-0079, `contacts` owns identity (name, email, phone,
 * tax id) and `suppliers` owns procurement lifecycle (code, category,
 * currency, incoterms, lead time). AP defaults stay on the contact and are
 * not duplicated here.
 *
 * Linking an existing contact promotes that party to the supplier role
 * rather than creating a duplicate company — this is how a customer that we
 * also buy from is modelled (ADR-0038 dual role).
 */
import { useState, useEffect } from "react";
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
import { useOrganization } from "@/hooks/useOrganization";
import { useBusinesses } from "@/contexts/BusinessContext";
import { useCurrencies } from "@/hooks/useCurrencies";
import { CurrencyCombobox } from "@/components/contacts/CurrencyCombobox";
import { useSupplierCategories } from "./useSuppliers";
import { createSupplier } from "./supplierRpcs";

interface PartyOption {
  id: string;
  name: string;
  email: string | null;
  phone: string | null;
  tax_id: string | null;
}

export default function SupplierCreatePage() {
  const navigate = useNavigate();
  const { toast } = useToast();
  const { currentOrg } = useOrganization();
  const { currentBusiness } = useBusinesses();
  const categories = useSupplierCategories();

  const [contactId, setContactId] = useState("");
  const [parties, setParties] = useState<PartyOption[]>([]);
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [phone, setPhone] = useState("");
  const [taxId, setTaxId] = useState("");
  const [code, setCode] = useState("");
  const [categoryId, setCategoryId] = useState<string>("");
  // H+1: default to workspace base currency (falls back to blank until BusinessContext hydrates)
  const [currency, setCurrency] = useState(currentBusiness?.base_currency ?? "");
  useEffect(() => {
    if (!currency && currentBusiness?.base_currency) {
      setCurrency(currentBusiness.base_currency);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentBusiness?.base_currency]);
  const [incoterms, setIncoterms] = useState("");
  const [leadTime, setLeadTime] = useState<string>("");
  const [notes, setNotes] = useState("");
  const [busy, setBusy] = useState(false);

  // Existing parties in this company — lets an existing customer become a
  // supplier without duplicating the party record.
  useEffect(() => {
    if (!currentBusiness) return;
    let cancelled = false;
    (async () => {
      const { data } = await (supabase as any)
        .from("contacts")
        .select("id, name, email, phone, tax_id")
        .eq("business_id", currentBusiness.id)
        .eq("is_active", true)
        .is("parent_contact_id", null)
        .order("name")
        .limit(500);
      if (!cancelled) setParties((data ?? []) as PartyOption[]);
    })();
    return () => {
      cancelled = true;
    };
  }, [currentBusiness?.id]);

  function selectParty(id: string) {
    setContactId(id);
    const p = parties.find((x) => x.id === id);
    if (p) {
      setName(p.name ?? "");
      setEmail(p.email ?? "");
      setPhone(p.phone ?? "");
      setTaxId(p.tax_id ?? "");
    }
  }

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
    if (!contactId && !name.trim()) {
      toast({ title: "Name is required", variant: "destructive" });
      return;
    }
    setBusy(true);
    try {
      const res = await createSupplier({
        businessId: currentBusiness.id,
        contactId: contactId || null,
        name: name.trim(),
        email: email.trim(),
        phone: phone.trim(),
        taxId: taxId.trim(),
        notes: notes.trim(),
        supplierCode: code.trim(),
        categoryId: categoryId || null,
        defaultCurrency: currency.trim(),
        defaultIncoterms: incoterms.trim(),
        defaultLeadTimeDays: leadTime ? Number(leadTime) : null,
      });

      toast({
        title: res.created ? "Supplier created" : "Supplier already existed",
        description: name.trim(),
      });
      navigate(`/purchases/suppliers/${res.supplier_id}`);
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
                <Label htmlFor="party">Existing contact (optional)</Label>
                <select
                  id="party"
                  value={contactId}
                  onChange={(e) => selectParty(e.target.value)}
                  className="mt-1 flex h-10 w-full rounded-md border border-input bg-background px-3 text-sm"
                >
                  <option value="">— Create a new party —</option>
                  {parties.map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.name}
                    </option>
                  ))}
                </select>
                <p className="mt-1 text-xs text-muted-foreground">
                  Link a contact you already trade with (e.g. a customer you
                  also buy from) instead of creating a duplicate party.
                </p>
              </div>
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
                <CurrencyCombobox
                  currencies={currencies}
                  value={currency}
                  onValueChange={setCurrency}
                  placeholder="Select currency…"
                  disabled={currenciesLoading}
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
