import { useState } from "react";
import { Link, useParams } from "react-router-dom";
import { useOnboardingTemplate } from "@/hooks/hr/useOnboardingTemplate";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Checkbox } from "@/components/ui/checkbox";
import { Badge } from "@/components/ui/badge";
import { ArrowLeft, Plus, Trash2, ChevronUp, ChevronDown, Loader2, Save } from "lucide-react";
import { ConfigPageHeader } from "./_ConfigShell";

const ROLES = ["hr", "manager", "it", "finance", "employee"];
const CATEGORIES = ["general", "documents", "equipment", "training", "compliance", "introductions"];

export default function OnboardingTemplateEditor() {
  const { id } = useParams<{ id: string }>();
  const { template, isLoading, updateTemplate, addItem, updateItem, deleteItem, move } =
    useOnboardingTemplate(id);

  const [meta, setMeta] = useState<{ name: string; description: string } | null>(null);
  const current = meta ?? (template ? { name: template.name, description: template.description ?? "" } : null);
  const dirty = template && current && (current.name !== template.name || (current.description || "") !== (template.description || ""));

  const [newItem, setNewItem] = useState({ title: "", category: "general", assigned_role: "hr", is_required: false });

  if (isLoading) return <div className="flex justify-center py-10"><Loader2 className="h-6 w-6 animate-spin" /></div>;
  if (!template) return <div className="text-sm text-muted-foreground">Template not found.</div>;

  const saveMeta = async () => {
    if (!current) return;
    await updateTemplate.mutateAsync({ name: current.name, description: current.description });
    setMeta(null);
  };

  const addNew = async () => {
    if (!newItem.title.trim()) return;
    await addItem.mutateAsync(newItem);
    setNewItem({ title: "", category: "general", assigned_role: "hr", is_required: false });
  };

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-2 text-sm">
        <Button variant="ghost" size="sm" asChild>
          <Link to=".."><ArrowLeft className="h-4 w-4 mr-1" /> Templates</Link>
        </Button>
        <Badge variant="secondary">{template.template_type}</Badge>
      </div>

      <ConfigPageHeader
        hideBack
        title={template.name}
        subtitle="Items appear, in order, on every employee assigned this template."
        action={dirty ? (
          <Button size="sm" onClick={saveMeta} disabled={updateTemplate.isPending}>
            <Save className="h-4 w-4 mr-1" /> Save changes
          </Button>
        ) : null}
      />

      <Card>
        <CardContent className="p-4 space-y-3">
          <div className="grid md:grid-cols-2 gap-3">
            <div className="space-y-1">
              <Label>Name</Label>
              <Input value={current?.name ?? ""} onChange={(e) => setMeta((m) => ({ ...(m ?? current!), name: e.target.value }))} />
            </div>
            <div className="space-y-1">
              <Label>Description</Label>
              <Textarea rows={2} value={current?.description ?? ""} onChange={(e) => setMeta((m) => ({ ...(m ?? current!), description: e.target.value }))} />
            </div>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardContent className="p-4 space-y-3">
          <div className="font-medium text-sm">Checklist items ({template.items.length})</div>

          {template.items.length === 0 && (
            <p className="text-sm text-muted-foreground">No items yet. Add the first checklist item below.</p>
          )}

          <div className="space-y-1">
            {template.items.map((item, idx) => (
              <ItemRow
                key={item.id}
                item={item}
                first={idx === 0}
                last={idx === template.items.length - 1}
                onUpdate={(patch) => updateItem.mutate({ id: item.id, patch })}
                onDelete={() => { if (confirm("Delete item?")) deleteItem.mutate(item.id); }}
                onMove={(dir) => move.mutate({ id: item.id, direction: dir })}
              />
            ))}
          </div>

          <div className="border-t pt-3 grid md:grid-cols-[1fr_140px_140px_100px_80px] gap-2 items-end">
            <div className="space-y-1">
              <Label className="text-xs">New item title</Label>
              <Input value={newItem.title} onChange={(e) => setNewItem((i) => ({ ...i, title: e.target.value }))} placeholder="e.g. Sign offer letter" />
            </div>
            <div className="space-y-1">
              <Label className="text-xs">Category</Label>
              <Select value={newItem.category} onValueChange={(v) => setNewItem((i) => ({ ...i, category: v }))}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  {CATEGORIES.map((c) => <SelectItem key={c} value={c}>{c}</SelectItem>)}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1">
              <Label className="text-xs">Assigned to</Label>
              <Select value={newItem.assigned_role} onValueChange={(v) => setNewItem((i) => ({ ...i, assigned_role: v }))}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  {ROLES.map((r) => <SelectItem key={r} value={r}>{r}</SelectItem>)}
                </SelectContent>
              </Select>
            </div>
            <div className="flex items-center gap-2 pb-2">
              <Checkbox id="req" checked={newItem.is_required} onCheckedChange={(v) => setNewItem((i) => ({ ...i, is_required: !!v }))} />
              <Label htmlFor="req" className="text-xs">Required</Label>
            </div>
            <Button size="sm" onClick={addNew} disabled={!newItem.title.trim() || addItem.isPending}>
              <Plus className="h-4 w-4" />
            </Button>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}

function ItemRow({
  item, first, last, onUpdate, onDelete, onMove,
}: {
  item: any;
  first: boolean;
  last: boolean;
  onUpdate: (patch: any) => void;
  onDelete: () => void;
  onMove: (dir: "up" | "down") => void;
}) {
  const [editing, setEditing] = useState(false);
  const [title, setTitle] = useState(item.title);

  return (
    <div className="grid grid-cols-[auto_1fr_120px_120px_80px_auto] gap-2 items-center px-2 py-1.5 rounded hover:bg-muted/40">
      <div className="flex flex-col">
        <Button variant="ghost" size="icon" className="h-5 w-5" disabled={first} onClick={() => onMove("up")}>
          <ChevronUp className="h-3 w-3" />
        </Button>
        <Button variant="ghost" size="icon" className="h-5 w-5" disabled={last} onClick={() => onMove("down")}>
          <ChevronDown className="h-3 w-3" />
        </Button>
      </div>
      {editing ? (
        <Input
          autoFocus value={title}
          onChange={(e) => setTitle(e.target.value)}
          onBlur={() => { if (title !== item.title) onUpdate({ title }); setEditing(false); }}
          onKeyDown={(e) => { if (e.key === "Enter") (e.target as HTMLInputElement).blur(); }}
          className="h-8"
        />
      ) : (
        <button className="text-sm text-left truncate" onClick={() => setEditing(true)}>
          {item.title} {item.is_required && <span className="text-destructive">*</span>}
        </button>
      )}
      <Select value={item.category || "general"} onValueChange={(v) => onUpdate({ category: v })}>
        <SelectTrigger className="h-8 text-xs"><SelectValue /></SelectTrigger>
        <SelectContent>{CATEGORIES.map((c) => <SelectItem key={c} value={c}>{c}</SelectItem>)}</SelectContent>
      </Select>
      <Select value={item.assigned_role || "hr"} onValueChange={(v) => onUpdate({ assigned_role: v })}>
        <SelectTrigger className="h-8 text-xs"><SelectValue /></SelectTrigger>
        <SelectContent>{ROLES.map((r) => <SelectItem key={r} value={r}>{r}</SelectItem>)}</SelectContent>
      </Select>
      <div className="flex items-center gap-1">
        <Checkbox checked={!!item.is_required} onCheckedChange={(v) => onUpdate({ is_required: !!v })} />
        <span className="text-xs text-muted-foreground">Req</span>
      </div>
      <Button variant="ghost" size="icon" onClick={onDelete}>
        <Trash2 className="h-3.5 w-3.5 text-destructive" />
      </Button>
    </div>
  );
}
