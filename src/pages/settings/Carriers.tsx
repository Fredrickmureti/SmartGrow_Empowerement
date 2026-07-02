/**
 * Carriers settings page (/settings/carriers).
 *
 * Manages the per-company carrier registry used by Delivery Note dispatch
 * (shipping_method=courier / third_party_logistics). Carriers are
 * business-scoped via RLS; cross-business assignment is rejected at the RPC
 * layer (`dispatch_delivery_atomic`, `update_delivery_logistics_atomic`).
 */
import { useState } from "react";
import { PlatformAppLayout } from "@/apps/platform";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Badge } from "@/components/ui/badge";
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from "@/components/ui/table";
import {
  Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle, DialogTrigger,
} from "@/components/ui/dialog";
import { useCarriers, type Carrier } from "@/hooks/useDeliveryLifecycle";
import { Loader2, Plus, Truck } from "lucide-react";

export default function CarriersSettings() {
  const { carriers, isLoading, createCarrier, updateCarrier } = useCarriers({ includeInactive: true });
  const [openCreate, setOpenCreate] = useState(false);
  const [editing, setEditing] = useState<Carrier | null>(null);

  return (
    <PlatformAppLayout>
      <div className="container mx-auto py-6 space-y-6">
        <div className="flex items-center justify-between">
          <div>
            <h1 className="text-2xl font-bold flex items-center gap-2">
              <Truck className="h-6 w-6" /> Carriers
            </h1>
            <p className="text-muted-foreground text-sm">
              Carriers selectable when dispatching Delivery Notes by courier or third-party logistics.
            </p>
          </div>
          <Dialog open={openCreate} onOpenChange={setOpenCreate}>
            <DialogTrigger asChild>
              <Button><Plus className="h-4 w-4 mr-2" /> New carrier</Button>
            </DialogTrigger>
            <CarrierForm
              title="New carrier"
              onSubmit={async (values) => { await createCarrier.mutateAsync(values); setOpenCreate(false); }}
              busy={createCarrier.isPending}
            />
          </Dialog>
        </div>

        <Card>
          <CardHeader>
            <CardTitle>Registered carriers</CardTitle>
            <CardDescription>Per company. Inactive carriers stay assignable to historic deliveries but cannot be selected for new dispatches.</CardDescription>
          </CardHeader>
          <CardContent>
            {isLoading ? (
              <div className="flex items-center justify-center py-10 text-muted-foreground"><Loader2 className="animate-spin mr-2" /> Loading…</div>
            ) : carriers.length === 0 ? (
              <div className="text-center text-muted-foreground py-10">No carriers yet. Add your first courier or logistics partner.</div>
            ) : (
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Name</TableHead>
                    <TableHead>Phone</TableHead>
                    <TableHead>Tracking URL template</TableHead>
                    <TableHead className="text-center w-24">Active</TableHead>
                    <TableHead className="text-right w-24">Actions</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {carriers.map((c) => (
                    <TableRow key={c.id}>
                      <TableCell className="font-medium">{c.name}</TableCell>
                      <TableCell>{c.contact_phone || <span className="text-muted-foreground">—</span>}</TableCell>
                      <TableCell className="font-mono text-xs">
                        {c.tracking_url_template || <span className="text-muted-foreground font-sans">—</span>}
                      </TableCell>
                      <TableCell className="text-center">
                        <Switch
                          checked={c.is_active}
                          onCheckedChange={(v) => updateCarrier.mutate({ id: c.id, patch: { is_active: v } })}
                        />
                      </TableCell>
                      <TableCell className="text-right">
                        <Button variant="ghost" size="sm" onClick={() => setEditing(c)}>Edit</Button>
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            )}
            <p className="text-xs text-muted-foreground mt-4">
              Tracking URL template may contain <Badge variant="outline" className="font-mono">{`{tracking_number}`}</Badge> as a placeholder.
            </p>
          </CardContent>
        </Card>
      </div>

      <Dialog open={!!editing} onOpenChange={(o) => { if (!o) setEditing(null); }}>
        {editing && (
          <CarrierForm
            title="Edit carrier"
            initial={editing}
            busy={updateCarrier.isPending}
            onSubmit={async (values) => {
              await updateCarrier.mutateAsync({ id: editing.id, patch: values });
              setEditing(null);
            }}
          />
        )}
      </Dialog>
    </PlatformAppLayout>
  );
}

function CarrierForm({
  title, initial, busy, onSubmit,
}: {
  title: string;
  initial?: Partial<Carrier>;
  busy?: boolean;
  onSubmit: (values: { name: string; contact_phone?: string; tracking_url_template?: string }) => Promise<void>;
}) {
  const [name, setName] = useState(initial?.name ?? "");
  const [phone, setPhone] = useState(initial?.contact_phone ?? "");
  const [tpl, setTpl] = useState(initial?.tracking_url_template ?? "");

  return (
    <DialogContent>
      <DialogHeader><DialogTitle>{title}</DialogTitle></DialogHeader>
      <div className="space-y-3">
        <div className="space-y-1">
          <Label>Name</Label>
          <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="DHL, Sendy, In-house fleet…" />
        </div>
        <div className="space-y-1">
          <Label>Contact phone</Label>
          <Input value={phone ?? ""} onChange={(e) => setPhone(e.target.value)} />
        </div>
        <div className="space-y-1">
          <Label>Tracking URL template</Label>
          <Input
            value={tpl ?? ""}
            onChange={(e) => setTpl(e.target.value)}
            placeholder="https://example.com/track/{tracking_number}"
          />
        </div>
      </div>
      <DialogFooter>
        <Button
          disabled={busy || !name.trim()}
          onClick={() => onSubmit({
            name: name.trim(),
            contact_phone: phone?.trim() || undefined,
            tracking_url_template: tpl?.trim() || undefined,
          })}
        >
          {busy ? "Saving…" : "Save"}
        </Button>
      </DialogFooter>
    </DialogContent>
  );
}
