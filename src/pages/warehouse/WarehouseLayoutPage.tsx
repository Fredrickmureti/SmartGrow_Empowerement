/**
 * WarehouseLayoutPage — author zone / aisle / rack / shelf / bin tree
 * under a chosen warehouse. Phase 0 authoring surface for the WMS
 * physical hierarchy stored in `stock_locations`.
 *
 * Inventory stays canonical: this page never touches quants; it only
 * authors location rows. Once bins exist, writers in later phases (put-
 * away, picking) stamp `source_location_id` / `destination_location_id`
 * on `stock_movements` so quants populate real bins instead of the
 * per-warehouse default.
 *
 * See ADR 0079 for scope, ADR 0064 for the underlying location model.
 */
import { useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { toast } from "sonner";
import {
  PageHeader,
  PageBody,
  Section,
  LoadingState,
  EmptyState,
  StatusBadge,
} from "@/design-system";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Badge } from "@/components/ui/badge";
import { useWarehouses } from "@/hooks/useWarehouses";
import { useBusinesses } from "@/hooks/useBusinesses";
import { useOrganization } from "@/hooks/useOrganization";
import { useAuth } from "@/contexts/AuthContext";
import { Plus, Network, ChevronRight, ChevronDown } from "lucide-react";

type StructureLevel = "zone" | "aisle" | "rack" | "shelf" | "bin" | "dock" | "staging_in" | "staging_out";

const LEVEL_ORDER: StructureLevel[] = ["zone", "aisle", "rack", "shelf", "bin", "dock", "staging_in", "staging_out"];

const LEVEL_LABEL: Record<StructureLevel, string> = {
  zone: "Zone",
  aisle: "Aisle",
  rack: "Rack",
  shelf: "Shelf",
  bin: "Bin",
  dock: "Dock",
  staging_in: "Staging (inbound)",
  staging_out: "Staging (outbound)",
};

interface LocationRow {
  id: string;
  warehouse_id: string;
  parent_location_id: string | null;
  code: string;
  name: string;
  location_type: string;
  usage: string;
  structure_level: StructureLevel | null;
  barcode: string | null;
  pick_sequence: number | null;
  is_active: boolean;
  is_default: boolean;
}

interface TreeNode extends LocationRow {
  children: TreeNode[];
}

function buildTree(rows: LocationRow[]): TreeNode[] {
  const map = new Map<string, TreeNode>();
  rows.forEach((r) => map.set(r.id, { ...r, children: [] }));
  const roots: TreeNode[] = [];
  map.forEach((node) => {
    if (node.parent_location_id && map.has(node.parent_location_id)) {
      map.get(node.parent_location_id)!.children.push(node);
    } else {
      roots.push(node);
    }
  });
  const sortRec = (nodes: TreeNode[]) => {
    nodes.sort((a, b) => {
      const sa = a.pick_sequence ?? 999999;
      const sb = b.pick_sequence ?? 999999;
      if (sa !== sb) return sa - sb;
      return a.code.localeCompare(b.code);
    });
    nodes.forEach((n) => sortRec(n.children));
  };
  sortRec(roots);
  return roots;
}

export default function WarehouseLayoutPage() {
  const { warehouses, isLoading: whLoading } = useWarehouses();
  const { currentBusiness } = useBusinesses();
  const { currentOrg } = useOrganization();
  const { user } = useAuth();
  const qc = useQueryClient();

  const [warehouseId, setWarehouseId] = useState<string | null>(null);
  const activeWarehouseId = warehouseId ?? warehouses[0]?.id ?? null;

  const { data: locations, isLoading: locLoading } = useQuery({
    queryKey: ["wms-locations", activeWarehouseId],
    enabled: !!activeWarehouseId,
    queryFn: async () => {
      const { data, error } = await supabase
        .from("stock_locations")
        .select("id, warehouse_id, parent_location_id, code, name, location_type, usage, structure_level, barcode, pick_sequence, is_active, is_default")
        .eq("warehouse_id", activeWarehouseId!)
        .order("code");
      if (error) throw error;
      return (data ?? []) as LocationRow[];
    },
  });

  const tree = useMemo(() => buildTree(locations ?? []), [locations]);

  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
  const toggle = (id: string) => setExpanded((s) => ({ ...s, [id]: !s[id] }));

  // Add-location dialog state
  const [addOpen, setAddOpen] = useState(false);
  const [addParent, setAddParent] = useState<LocationRow | null>(null);
  const [form, setForm] = useState({
    code: "",
    name: "",
    structure_level: "zone" as StructureLevel,
    barcode: "",
    pick_sequence: "" as string,
  });

  const openAdd = (parent: LocationRow | null) => {
    setAddParent(parent);
    const defaultLevel: StructureLevel = parent?.structure_level
      ? nextLevel(parent.structure_level)
      : "zone";
    setForm({ code: "", name: "", structure_level: defaultLevel, barcode: "", pick_sequence: "" });
    setAddOpen(true);
  };

  const create = useMutation({
    mutationFn: async () => {
      if (!activeWarehouseId || !currentBusiness?.id || !currentOrg?.id) {
        throw new Error("Select a warehouse first.");
      }
      const usage: "receive" | "ship" | "storage" =
        form.structure_level === "dock" ? "receive"
        : form.structure_level === "staging_out" ? "ship"
        : form.structure_level === "staging_in" ? "receive"
        : "storage";
      const payload = {
        warehouse_id: activeWarehouseId,
        parent_location_id: addParent?.id ?? null,
        organization_id: currentOrg.id,
        business_id: currentBusiness.id,
        branch_id: warehouses.find((w) => w.id === activeWarehouseId)?.branch_id ?? null,
        code: form.code.trim(),
        name: form.name.trim() || form.code.trim(),
        location_type: "internal" as const,
        usage,
        structure_level: form.structure_level,
        barcode: form.barcode.trim() || null,
        pick_sequence: form.pick_sequence ? Number(form.pick_sequence) : null,
        is_active: true,
        is_default: false,
        created_by: user?.id ?? null,
      };
      const { error } = await supabase.from("stock_locations").insert(payload);
      if (error) throw error;
    },
    onSuccess: () => {
      toast.success("Location created");
      setAddOpen(false);
      qc.invalidateQueries({ queryKey: ["wms-locations", activeWarehouseId] });
      qc.invalidateQueries({ queryKey: ["wms-location-count"] });
      qc.invalidateQueries({ queryKey: ["wms-authored-layout-count"] });
    },
    onError: (e: unknown) => {
      const msg = e instanceof Error ? e.message : "Failed to create location";
      toast.error(msg);
    },
  });

  const isLoading = whLoading || locLoading;
  const activeWarehouse = warehouses.find((w) => w.id === activeWarehouseId) ?? null;

  return (
    <>
      <PageHeader
        title="Warehouse layout"
        description="Author the physical hierarchy — zone → aisle → rack → shelf → bin, plus docks and staging areas."
        actions={
          <div className="flex items-center gap-2">
            <Select value={activeWarehouseId ?? ""} onValueChange={(v) => setWarehouseId(v)}>
              <SelectTrigger className="w-[220px]"><SelectValue placeholder="Choose warehouse" /></SelectTrigger>
              <SelectContent>
                {warehouses.map((w) => (
                  <SelectItem key={w.id} value={w.id}>{w.name}</SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Button onClick={() => openAdd(null)} disabled={!activeWarehouseId}>
              <Plus className="mr-2 h-4 w-4" /> Add zone
            </Button>
          </div>
        }
      />
      <PageBody>
        {isLoading && <Section><LoadingState /></Section>}

        {!isLoading && !activeWarehouseId && (
          <Section>
            <EmptyState
              icon={Network}
              title="No warehouse selected"
              description="Create a warehouse first, then return here to author its physical layout."
            />
          </Section>
        )}

        {!isLoading && activeWarehouseId && (
          <Section
            title={activeWarehouse?.name}
            description="Every warehouse starts with an auto-seeded default location. Add zones, aisles, racks, shelves, and bins to unlock bin-level put-away, picking, and cycle counts."
          >
            <Card>
              <CardHeader className="pb-2">
                <CardTitle className="text-sm font-medium flex items-center gap-2">
                  <Network className="h-4 w-4" /> Location tree
                </CardTitle>
              </CardHeader>
              <CardContent>
                {tree.length === 0 ? (
                  <EmptyState
                    icon={Network}
                    title="No locations yet"
                    description="Start by adding a zone (e.g. Receiving, Ambient, Cold Chain)."
                    action={
                      <Button onClick={() => openAdd(null)}>
                        <Plus className="mr-2 h-4 w-4" /> Add first zone
                      </Button>
                    }
                  />
                ) : (
                  <ul className="space-y-1">
                    {tree.map((n) => (
                      <TreeItem
                        key={n.id}
                        node={n}
                        depth={0}
                        expanded={expanded}
                        toggle={toggle}
                        onAdd={openAdd}
                      />
                    ))}
                  </ul>
                )}
              </CardContent>
            </Card>
          </Section>
        )}
      </PageBody>

      <Dialog open={addOpen} onOpenChange={setAddOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>
              {addParent ? `Add under ${addParent.code}` : "Add zone"}
            </DialogTitle>
          </DialogHeader>
          <div className="space-y-3">
            <div className="grid grid-cols-2 gap-3">
              <div>
                <Label>Code *</Label>
                <Input value={form.code} onChange={(e) => setForm({ ...form, code: e.target.value })} placeholder="e.g. Z1-A2-R3-B04" />
              </div>
              <div>
                <Label>Level *</Label>
                <Select value={form.structure_level} onValueChange={(v: StructureLevel) => setForm({ ...form, structure_level: v })}>
                  <SelectTrigger><SelectValue /></SelectTrigger>
                  <SelectContent>
                    {LEVEL_ORDER.map((l) => (
                      <SelectItem key={l} value={l}>{LEVEL_LABEL[l]}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            </div>
            <div>
              <Label>Display name</Label>
              <Input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} placeholder="Defaults to code" />
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div>
                <Label>Barcode</Label>
                <Input value={form.barcode} onChange={(e) => setForm({ ...form, barcode: e.target.value })} placeholder="Scan-to-select" />
              </div>
              <div>
                <Label>Pick sequence</Label>
                <Input
                  type="number"
                  value={form.pick_sequence}
                  onChange={(e) => setForm({ ...form, pick_sequence: e.target.value })}
                  placeholder="e.g. 10, 20, 30"
                />
              </div>
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setAddOpen(false)}>Cancel</Button>
            <Button
              disabled={!form.code.trim() || create.isPending}
              onClick={() => create.mutate()}
            >
              {create.isPending ? "Creating…" : "Create"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}

function nextLevel(current: StructureLevel): StructureLevel {
  switch (current) {
    case "zone": return "aisle";
    case "aisle": return "rack";
    case "rack": return "shelf";
    case "shelf": return "bin";
    default: return "bin";
  }
}

function TreeItem({
  node,
  depth,
  expanded,
  toggle,
  onAdd,
}: {
  node: TreeNode;
  depth: number;
  expanded: Record<string, boolean>;
  toggle: (id: string) => void;
  onAdd: (parent: LocationRow) => void;
}) {
  const isOpen = expanded[node.id] ?? depth < 1;
  const hasChildren = node.children.length > 0;
  return (
    <li>
      <div
        className="flex items-center gap-2 rounded-md px-2 py-1.5 hover:bg-muted/60"
        style={{ paddingLeft: 8 + depth * 16 }}
      >
        <button
          type="button"
          onClick={() => toggle(node.id)}
          className="w-4 text-muted-foreground"
          aria-label={isOpen ? "Collapse" : "Expand"}
        >
          {hasChildren ? (isOpen ? <ChevronDown className="h-4 w-4" /> : <ChevronRight className="h-4 w-4" />) : null}
        </button>
        <span className="font-mono text-xs">{node.code}</span>
        <span className="text-sm text-muted-foreground">{node.name}</span>
        {node.structure_level && (
          <Badge variant="outline" className="text-[10px] uppercase">{node.structure_level}</Badge>
        )}
        {node.is_default && <StatusBadge tone="neutral">default</StatusBadge>}
        {!node.is_active && <StatusBadge tone="warning">inactive</StatusBadge>}
        <div className="ml-auto">
          <Button variant="ghost" size="sm" onClick={() => onAdd(node)}>
            <Plus className="h-3.5 w-3.5 mr-1" /> Add child
          </Button>
        </div>
      </div>
      {hasChildren && isOpen && (
        <ul className="space-y-1">
          {node.children.map((c) => (
            <TreeItem key={c.id} node={c} depth={depth + 1} expanded={expanded} toggle={toggle} onAdd={onAdd} />
          ))}
        </ul>
      )}
    </li>
  );
}
