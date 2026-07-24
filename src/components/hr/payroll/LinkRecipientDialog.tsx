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
 * Never writes recipient fields from the client — every mutation
 * goes through a security-definer RPC that enforces org membership
 * and duplicate-identity guards (merge-required error surfaces
 * cleanly in the toast).
 */
import { useMemo, useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { supabase } from "@/integrations/supabase/client";
import { useOrganization } from "@/hooks/useOrganization";
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
  contact_type: string | null;
}

export function LinkRecipientDialog({
  open,
  onOpenChange,
  mode,
  onLinked,
}: LinkRecipientDialogProps) {
  const { currentOrg } = useOrganization();
  const orgId = currentOrg?.id ?? null;
  const [search, setSearch] = useState("");
  const [selected, setSelected] = useState<ContactRow | null>(null);
  const qc = useQueryClient();

  const { data: contacts = [], isLoading } = useQuery<ContactRow[]>({
    enabled: open && !!orgId,
    queryKey: ["link-recipient-contacts", orgId, search],
    queryFn: async () => {
      let q = (supabase as any)
        .from("contacts")
        .select("id,name,email,phone,country,contact_type")
        .eq("organization_id", orgId!)
        .order("name", { ascending: true })
        .limit(50);
      if (search.trim()) q = q.ilike("name", `%${search.trim()}%`);
      const { data, error } = await q;
      if (error) throw error;
      return (data ?? []) as ContactRow[];
    },
  });

  const link = useMutation({
    mutationFn: async (contact: ContactRow) => {
      if (!mode) throw new Error("no mode");
      if (mode.kind === "recipient") {
        const { data, error } = await (supabase as any).rpc(
          "legal_recipient_link_contact",
          {
            p_recipient_id: mode.recipientId,
            p_contact_id: contact.id,
            p_copy_defaults: true,
          },
        );
        if (error) throw error;
        return data as { recipient_id: string; contact_id: string };
      }
      const { data, error } = await (supabase as any).rpc(
        "legal_order_attach_contact",
        { p_order_id: mode.orderId, p_contact_id: contact.id },
      );
      if (error) throw error;
      return data as { recipient_id: string; contact_id: string };
    },
    onSuccess: (result) => {
      toast.success("Recipient linked to Contact");
      qc.invalidateQueries({ queryKey: ["legal-recipients"] });
      qc.invalidateQueries({ queryKey: ["legal-recipient-outstanding"] });
      qc.invalidateQueries({ queryKey: ["garnishments"] });
      qc.invalidateQueries({ queryKey: ["legal-orders"] });
      onLinked?.(result);
      onOpenChange(false);
      setSelected(null);
      setSearch("");
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

  const heading = useMemo(() => {
    if (!mode) return "Link Recipient";
    return mode.kind === "recipient"
      ? `Link ${mode.recipientName} to a Contact`
      : `Set recipient Contact for ${mode.orderLabel}`;
  }, [mode]);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>{heading}</DialogTitle>
          <DialogDescription>
            {mode?.kind === "order"
              ? "Choose the third-party Contact (court, agency, creditor, SACCO) that will receive remittance. The recipient master record is created or reused automatically."
              : "Pick the Contact that represents this recipient. Empty fields on the recipient (email, phone, address) are copied from the Contact."}
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-3">
          <div>
            <Label htmlFor="link-recipient-search">Search contacts</Label>
            <Input
              id="link-recipient-search"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Court name, agency, creditor…"
            />
          </div>

          <ScrollArea className="h-72 rounded border">
            {isLoading ? (
              <p className="p-3 text-sm text-muted-foreground">Loading…</p>
            ) : contacts.length === 0 ? (
              <p className="p-3 text-sm text-muted-foreground">
                No contacts match. Create the Contact from the Contacts module
                first, then return here.
              </p>
            ) : (
              <ul className="divide-y">
                {contacts.map((c) => {
                  const isSel = selected?.id === c.id;
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
                        </div>
                        {c.contact_type && (
                          <Badge variant="outline" className="text-[10px]">
                            {c.contact_type}
                          </Badge>
                        )}
                      </div>
                    </li>
                  );
                })}
              </ul>
            )}
          </ScrollArea>
        </div>

        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button
            disabled={!selected || link.isPending}
            onClick={() => selected && link.mutate(selected)}
          >
            {link.isPending ? "Linking…" : "Link"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
