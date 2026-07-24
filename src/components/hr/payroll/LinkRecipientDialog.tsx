/**
 * LinkRecipientDialog — Phase 7 Step 0 (recipient linking gap fix).
 *
 * Shared dialog used from two entry points:
 *
 *   1. `LegalRecipients` list, per-row "Link to Contact" action —
 *      calls `legal_recipient_link_contact(recipient_id, contact_id)`
 *      to attach a Contact to an existing recipient identity so
 *      remittance/bank-file generation can proceed.
 *
 *   2. `Garnishments` list, "recipient not linked" badge —
 *      calls `legal_order_attach_contact(order_id, contact_id)` to
 *      pick a Contact for the order; the RPC finds or creates the
 *      matching `legal_recipients` row and stamps
 *      `legal_orders_records.recipient_id`.
 *
 * ── Role-aware picker (ADR-0093 §Recipient Contact roles) ────────────
 *
 * Candidates are scored so the operator can't mis-link blindly:
 *
 *   Recipient  → already backs a legal_recipients row (best)
 *   Vendor     → supplier_rank > 0 (SACCOs, existing AP vendors — allowed)
 *   Party-only → both ranks = 0 (created just for garnishments — allowed)
 *   Customer   → customer_rank > 0 & supplier_rank = 0
 *                Hidden by default. Toggle "Include customers" to reveal;
 *                each row is flagged with an inline warning.
 *
 * ── Inline "New recipient" (party-only contact) ──────────────────────
 *
 * A `+ New recipient` panel creates a fresh Contact with
 * `customer_rank = 0` and `supplier_rank = 0` (no `type` set), then
 * runs the same attach/link RPC against the new id. The party-only
 * contact stays out of Customers/Vendors lists (they filter by
 * rank > 0) but is fully available for promotion to a vendor later —
 * a rank flip on the same row, per ADR-0038/0079.
 *
 * Never writes recipient fields from the client — every recipient-side
 * mutation goes through a security-definer RPC that enforces org
 * membership and duplicate-identity guards (merge-required error
 * surfaces cleanly in the toast).
 */
import { useMemo, useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { supabase } from "@/integrations/supabase/client";
import { useOrganization } from "@/hooks/useOrganization";
import { useBusinesses } from "@/hooks/useBusinesses";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Badge } from "@/components/ui/badge";
import { Checkbox } from "@/components/ui/checkbox";
import { Plus, AlertTriangle } from "lucide-react";

type Mode =
  | { kind: "recipient"; recipientId: string; recipientName: string }
  | { kind: "order"; orderId: string; orderLabel: string };

export interface LinkRecipientDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  mode: Mode | null;
  onLinked?: (result: { recipient_id: string; contact_id: string }) => void;
}

interface ContactRow {
  id: string;
  name: string;
  email: string | null;
  phone: string | null;
  country: string | null;
  type: string | null;
  customer_rank: number | null;
  supplier_rank: number | null;
}

interface AuthorityRow {
  id: string;
  name: string;
  code: string;
  authority_type: string;
  jurisdiction_country: string | null;
  jurisdiction_region: string | null;
  contact_email: string | null;
  contact_phone: string | null;
  contact_id: string | null;
  is_active: boolean;
}

type RoleTag = "recipient" | "authority" | "vendor" | "party-only" | "customer";

function roleOf(c: ContactRow, recipientIds: Set<string>, authorityContactIds: Set<string>): RoleTag {
  if (recipientIds.has(c.id)) return "recipient";
  if (authorityContactIds.has(c.id)) return "authority";
  const s = Number(c.supplier_rank ?? 0);
  const cu = Number(c.customer_rank ?? 0);
  if (s > 0) return "vendor";
  if (cu > 0) return "customer";
  return "party-only";
}

// Preferred first, customer last.
const ROLE_ORDER: Record<RoleTag, number> = {
  recipient: 0,
  authority: 1,
  vendor: 2,
  "party-only": 3,
  customer: 4,
};

const ROLE_BADGE: Record<RoleTag, { label: string; variant: "default" | "secondary" | "outline" | "destructive" }> = {
  recipient: { label: "Recipient", variant: "default" },
  authority: { label: "Authority", variant: "secondary" },
  vendor: { label: "Vendor", variant: "secondary" },
  "party-only": { label: "Party-only", variant: "outline" },
  customer: { label: "Customer", variant: "destructive" },
};


export function LinkRecipientDialog({
  open,
  onOpenChange,
  mode,
  onLinked,
}: LinkRecipientDialogProps) {
  const { currentOrg } = useOrganization();
  const { currentBusiness } = useBusinesses();
  const orgId = currentOrg?.id ?? null;
  const businessId = currentBusiness?.id ?? null;
  const [search, setSearch] = useState("");
  const [selected, setSelected] = useState<ContactRow | null>(null);
  const [includeCustomers, setIncludeCustomers] = useState(false);
  const [showCreate, setShowCreate] = useState(false);
  const [newContact, setNewContact] = useState({
    name: "",
    email: "",
    phone: "",
    country: "",
    is_company: true,
  });
  const qc = useQueryClient();

  const resetAndClose = () => {
    onOpenChange(false);
    setSelected(null);
    setSearch("");
    setShowCreate(false);
    setNewContact({ name: "", email: "", phone: "", country: "", is_company: true });
  };

  // Existing recipient contact ids for this org (drives "Recipient" badge).
  const { data: recipientIds } = useQuery<Set<string>>({
    enabled: open && !!orgId,
    queryKey: ["link-recipient-ids", orgId],
    queryFn: async () => {
      const { data, error } = await (supabase as any)
        .from("legal_recipients")
        .select("contact_id")
        .eq("organization_id", orgId!)
        .not("contact_id", "is", null);
      if (error) throw error;
      return new Set(((data ?? []) as { contact_id: string }[]).map((r) => r.contact_id));
    },
    staleTime: 30_000,
  });

  // Curated issuing authorities (courts/agencies) — shown as first-class candidates.
  const { data: authorities = [] } = useQuery<AuthorityRow[]>({
    enabled: open && !!orgId,
    queryKey: ["link-recipient-authorities", orgId, search],
    queryFn: async () => {
      let q = (supabase as any)
        .from("legal_order_authorities")
        .select("id,name,code,authority_type,jurisdiction_country,jurisdiction_region,contact_email,contact_phone,contact_id,is_active")
        .eq("organization_id", orgId!)
        .eq("is_active", true)
        .order("name", { ascending: true })
        .limit(50);
      const s = search.trim();
      if (s) q = q.or(`name.ilike.%${s}%,code.ilike.%${s}%,authority_type.ilike.%${s}%`);
      const { data, error } = await q;
      if (error) throw error;
      return (data ?? []) as AuthorityRow[];
    },
    staleTime: 30_000,
  });

  const authorityContactIds = useMemo(
    () => new Set(authorities.map((a) => a.contact_id).filter((v): v is string => !!v)),
    [authorities],
  );

  const { data: contacts = [], isLoading } = useQuery<ContactRow[]>({
    enabled: open && !!orgId,
    queryKey: ["link-recipient-contacts", orgId, search],
    queryFn: async () => {
      let q = (supabase as any)
        .from("contacts")
        .select("id,name,email,phone,country,type,customer_rank,supplier_rank")
        .eq("organization_id", orgId!)
        .order("name", { ascending: true })
        .limit(100);
      const s = search.trim();
      if (s) q = q.or(`name.ilike.%${s}%,email.ilike.%${s}%,phone.ilike.%${s}%`);
      const { data, error } = await q;
      if (error) throw error;
      return (data ?? []) as ContactRow[];
    },
  });

  const rIds = recipientIds ?? new Set<string>();
  const scored = useMemo(() => {
    // Drop contacts that are already surfaced via an authority row (avoid duplication).
    const rows = contacts
      .filter((c) => !authorityContactIds.has(c.id))
      .map((c) => ({ c, role: roleOf(c, rIds, authorityContactIds) }));
    const visible = includeCustomers ? rows : rows.filter((r) => r.role !== "customer");
    visible.sort((a, b) => {
      const d = ROLE_ORDER[a.role] - ROLE_ORDER[b.role];
      if (d !== 0) return d;
      return a.c.name.localeCompare(b.c.name);
    });
    return visible;
  }, [contacts, rIds, authorityContactIds, includeCustomers]);

  const hiddenCustomerCount = useMemo(
    () =>
      includeCustomers
        ? 0
        : contacts.filter((c) => roleOf(c, rIds, authorityContactIds) === "customer").length,
    [contacts, rIds, authorityContactIds, includeCustomers],
  );


  const linkExistingContact = async (contactId: string) => {
    if (!mode) throw new Error("no mode");
    if (mode.kind === "recipient") {
      const { data, error } = await (supabase as any).rpc(
        "legal_recipient_link_contact",
        {
          p_recipient_id: mode.recipientId,
          p_contact_id: contactId,
          p_copy_defaults: true,
        },
      );
      if (error) throw error;
      return data as { recipient_id: string; contact_id: string };
    }
    const { data, error } = await (supabase as any).rpc(
      "legal_order_attach_contact",
      { p_order_id: mode.orderId, p_contact_id: contactId },
    );
    if (error) throw error;
    return data as { recipient_id: string; contact_id: string };
  };

  const link = useMutation({
    mutationFn: async (contact: ContactRow) => linkExistingContact(contact.id),
    onSuccess: (result) => {
      toast.success("Recipient linked to Contact");
      qc.invalidateQueries({ queryKey: ["legal-recipients"] });
      qc.invalidateQueries({ queryKey: ["legal-recipient-outstanding"] });
      qc.invalidateQueries({ queryKey: ["garnishments"] });
      qc.invalidateQueries({ queryKey: ["legal-orders"] });
      onLinked?.(result);
      resetAndClose();
    },
    onError: (err: any) => {
      const msg = err?.message ?? String(err);
      if (msg.includes("MERGE_REQUIRED")) {
        toast.error(
          "Another active recipient already exists for this contact — use Merge instead.",
        );
      } else {
        toast.error(msg);
      }
    },
  });

  const create = useMutation({
    mutationFn: async () => {
      if (!orgId || !businessId) throw new Error("No business selected");
      const name = newContact.name.trim();
      if (!name) throw new Error("Name is required");

      // Party-only contact: no customer/supplier role, no default AR/AP
      // account mapping. Recipient role is expressed by the
      // legal_recipients linkage created by the RPC below.
      const insert: any = {
        organization_id: orgId,
        business_id: businessId,
        name,
        email: newContact.email.trim() || null,
        phone: newContact.phone.trim() || null,
        country: newContact.country.trim() || null,
        is_company: newContact.is_company,
        is_active: true,
        customer_rank: 0,
        supplier_rank: 0,
        type: null,
      };
      const { data: created, error: cErr } = await (supabase as any)
        .from("contacts")
        .insert(insert)
        .select("id,name,email,phone,country,type,customer_rank,supplier_rank")
        .single();
      if (cErr) throw cErr;
      const contactId = (created as ContactRow).id;
      const result = await linkExistingContact(contactId);
      return { result, created: created as ContactRow };
    },
    onSuccess: ({ result }) => {
      toast.success("Recipient created and linked");
      qc.invalidateQueries({ queryKey: ["link-recipient-contacts"] });
      qc.invalidateQueries({ queryKey: ["link-recipient-ids"] });
      qc.invalidateQueries({ queryKey: ["legal-recipients"] });
      qc.invalidateQueries({ queryKey: ["legal-recipient-outstanding"] });
      qc.invalidateQueries({ queryKey: ["garnishments"] });
      qc.invalidateQueries({ queryKey: ["legal-orders"] });
      onLinked?.(result);
      resetAndClose();
    },
    onError: (err: any) => {
      toast.error(err?.message ?? String(err));
    },
  });

  const heading = useMemo(() => {
    if (!mode) return "Link Recipient";
    return mode.kind === "recipient"
      ? `Link ${mode.recipientName} to a Contact`
      : `Set recipient Contact for ${mode.orderLabel}`;
  }, [mode]);

  return (
    <Dialog open={open} onOpenChange={(v) => (v ? onOpenChange(true) : resetAndClose())}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>{heading}</DialogTitle>
          <DialogDescription>
            {mode?.kind === "order"
              ? "Choose the third-party Contact (court, agency, creditor, SACCO) that will receive remittance. The recipient master record is created or reused automatically."
              : "Pick the Contact that represents this recipient. Empty fields on the recipient (email, phone, address) are copied from the Contact."}
          </DialogDescription>
        </DialogHeader>

        {showCreate ? (
          <div className="space-y-3">
            <div className="rounded border bg-muted/30 p-3 text-xs text-muted-foreground">
              Creates a party-only Contact (not a customer, not a vendor). It
              stays out of AR/AP lists and can be promoted to a vendor later
              without a merge.
            </div>
            <div className="grid gap-3">
              <div>
                <Label htmlFor="new-recipient-name">Name *</Label>
                <Input
                  id="new-recipient-name"
                  autoFocus
                  value={newContact.name}
                  onChange={(e) => setNewContact((p) => ({ ...p, name: e.target.value }))}
                  placeholder="Nairobi Family Court, CSA, ABC SACCO…"
                />
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <Label htmlFor="new-recipient-email">Email</Label>
                  <Input
                    id="new-recipient-email"
                    type="email"
                    value={newContact.email}
                    onChange={(e) => setNewContact((p) => ({ ...p, email: e.target.value }))}
                  />
                </div>
                <div>
                  <Label htmlFor="new-recipient-phone">Phone</Label>
                  <Input
                    id="new-recipient-phone"
                    value={newContact.phone}
                    onChange={(e) => setNewContact((p) => ({ ...p, phone: e.target.value }))}
                  />
                </div>
              </div>
              <div>
                <Label htmlFor="new-recipient-country">Country</Label>
                <Input
                  id="new-recipient-country"
                  value={newContact.country}
                  onChange={(e) => setNewContact((p) => ({ ...p, country: e.target.value }))}
                  placeholder="KE"
                />
              </div>
              <label className="flex items-center gap-2 text-sm">
                <Checkbox
                  checked={newContact.is_company}
                  onCheckedChange={(v) =>
                    setNewContact((p) => ({ ...p, is_company: v === true }))
                  }
                />
                <span>This is an organization (court / agency / SACCO)</span>
              </label>
            </div>
          </div>
        ) : (
          <div className="space-y-3">
            <div className="flex items-end gap-2">
              <div className="flex-1">
                <Label htmlFor="link-recipient-search">Search contacts</Label>
                <Input
                  id="link-recipient-search"
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                  placeholder="Court name, agency, creditor, SACCO…"
                />
              </div>
              <Button
                type="button"
                variant="outline"
                onClick={() => setShowCreate(true)}
                title="Create a party-only Contact for this recipient"
              >
                <Plus className="h-4 w-4 mr-1" /> New recipient
              </Button>
            </div>

            <label className="flex items-center gap-2 text-xs text-muted-foreground">
              <Checkbox
                checked={includeCustomers}
                onCheckedChange={(v) => setIncludeCustomers(v === true)}
              />
              <span>
                Include customers in results
                {hiddenCustomerCount > 0 && !includeCustomers ? (
                  <span className="ml-1">({hiddenCustomerCount} hidden)</span>
                ) : null}
              </span>
            </label>

            <ScrollArea className="h-64 rounded border">
              {isLoading ? (
                <p className="p-3 text-sm text-muted-foreground">Loading…</p>
              ) : scored.length === 0 ? (
                <div className="p-3 text-sm text-muted-foreground space-y-2">
                  <p>
                    No matching contacts. Recipients are usually courts,
                    agencies, creditors or SACCOs — none exist yet.
                  </p>
                  <Button
                    type="button"
                    size="sm"
                    variant="outline"
                    onClick={() => setShowCreate(true)}
                  >
                    <Plus className="h-4 w-4 mr-1" /> Create one now
                  </Button>
                </div>
              ) : (
                <ul className="divide-y">
                  {scored.map(({ c, role }) => {
                    const isSel = selected?.id === c.id;
                    const badge = ROLE_BADGE[role];
                    return (
                      <li
                        key={c.id}
                        className={`p-3 cursor-pointer hover:bg-muted/40 ${
                          isSel ? "bg-muted" : ""
                        }`}
                        onClick={() => setSelected(c)}
                      >
                        <div className="flex items-center justify-between gap-2">
                          <div className="min-w-0">
                            <div className="font-medium truncate">{c.name}</div>
                            <div className="text-xs text-muted-foreground truncate">
                              {[c.email, c.phone, c.country]
                                .filter(Boolean)
                                .join(" · ") || "—"}
                            </div>
                            {role === "customer" && (
                              <div className="mt-1 flex items-center gap-1 text-[11px] text-destructive">
                                <AlertTriangle className="h-3 w-3" />
                                Usually not a recipient — double-check before linking.
                              </div>
                            )}
                          </div>
                          <Badge variant={badge.variant} className="text-[10px] shrink-0">
                            {badge.label}
                          </Badge>
                        </div>
                      </li>
                    );
                  })}
                </ul>
              )}
            </ScrollArea>
          </div>
        )}

        <DialogFooter>
          {showCreate ? (
            <>
              <Button variant="ghost" onClick={() => setShowCreate(false)}>
                Back
              </Button>
              <Button
                disabled={!newContact.name.trim() || create.isPending}
                onClick={() => create.mutate()}
              >
                {create.isPending ? "Creating…" : "Create & link"}
              </Button>
            </>
          ) : (
            <>
              <Button variant="ghost" onClick={resetAndClose}>
                Cancel
              </Button>
              <Button
                disabled={!selected || link.isPending}
                onClick={() => selected && link.mutate(selected)}
              >
                {link.isPending ? "Linking…" : "Link"}
              </Button>
            </>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
