import { useState } from "react";
import { useProductCategories, type CategoryTreeNode } from "@/hooks/useProductCategories";
import { DetailSheet } from "@/design-system";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Badge } from "@/components/ui/badge";
import { useToast } from "@/hooks/use-toast";
import {
  Plus,
  Loader2,
  Pencil,
  Trash2,
  FolderTree,
  ChevronRight,
  ChevronDown,
} from "lucide-react";

interface ProductCategoriesManagerProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

const COLORS = [
  { label: "Blue", value: "blue" },
  { label: "Green", value: "green" },
  { label: "Red", value: "red" },
  { label: "Purple", value: "purple" },
  { label: "Orange", value: "orange" },
  { label: "Yellow", value: "yellow" },
  { label: "Pink", value: "pink" },
  { label: "Teal", value: "teal" },
];

const COLOR_CLASSES: Record<string, string> = {
  blue: "bg-blue-100 text-blue-800 dark:bg-blue-900/30 dark:text-blue-300",
  green: "bg-green-100 text-green-800 dark:bg-green-900/30 dark:text-green-300",
  red: "bg-red-100 text-red-800 dark:bg-red-900/30 dark:text-red-300",
  purple: "bg-purple-100 text-purple-800 dark:bg-purple-900/30 dark:text-purple-300",
  orange: "bg-orange-100 text-orange-800 dark:bg-orange-900/30 dark:text-orange-300",
  yellow: "bg-yellow-100 text-yellow-800 dark:bg-yellow-900/30 dark:text-yellow-300",
  pink: "bg-pink-100 text-pink-800 dark:bg-pink-900/30 dark:text-pink-300",
  teal: "bg-teal-100 text-teal-800 dark:bg-teal-900/30 dark:text-teal-300",
};

export function getCategoryColorClass(color: string | null): string {
  if (!color) return "";
  return COLOR_CLASSES[color] || "";
}

export function ProductCategoriesManager({ open, onOpenChange }: ProductCategoriesManagerProps) {
  const { categoryTree, flatTreeList, createCategory, updateCategory, deleteCategory, isCreating, isDeleting } = useProductCategories();
  const { toast } = useToast();

  const [showForm, setShowForm] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [formName, setFormName] = useState("");
  const [formDescription, setFormDescription] = useState("");
  const [formParentId, setFormParentId] = useState<string | null>(null);
  const [formColor, setFormColor] = useState<string | null>(null);
  const [expandedNodes, setExpandedNodes] = useState<Set<string>>(new Set());

  const resetForm = () => {
    setShowForm(false);
    setEditingId(null);
    setFormName("");
    setFormDescription("");
    setFormParentId(null);
    setFormColor(null);
  };

  const handleEdit = (node: CategoryTreeNode) => {
    setEditingId(node.id);
    setFormName(node.name);
    setFormDescription(node.description || "");
    setFormParentId(node.parent_id);
    setFormColor(node.color);
    setShowForm(true);
  };

  const handleSubmit = async () => {
    if (!formName.trim()) return;

    try {
      if (editingId) {
        await updateCategory({
          id: editingId,
          name: formName.trim(),
          description: formDescription || null,
          parent_id: formParentId,
          color: formColor,
        });
        toast({ title: "Category updated" });
      } else {
        await createCategory({
          name: formName.trim(),
          description: formDescription || undefined,
          parent_id: formParentId,
          color: formColor || undefined,
        });
        toast({ title: "Category created" });
      }
      resetForm();
    } catch {
      // Errors handled by hook
    }
  };

  const handleDelete = async (id: string, name: string) => {
    try {
      await deleteCategory(id);
      toast({ title: `"${name}" deleted` });
    } catch {
      // Error handled by hook
    }
  };

  const toggleExpand = (id: string) => {
    setExpandedNodes((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const renderNode = (node: CategoryTreeNode) => {
    const hasChildren = node.children.length > 0;
    const isExpanded = expandedNodes.has(node.id);

    return (
      <div key={node.id}>
        <div
          className="flex items-center gap-2 py-2 px-3 hover:bg-muted/50 rounded-md group"
          style={{ paddingLeft: `${node.depth * 20 + 12}px` }}
        >
          {hasChildren ? (
            <button onClick={() => toggleExpand(node.id)} className="p-0.5">
              {isExpanded ? (
                <ChevronDown className="h-3.5 w-3.5 text-muted-foreground" />
              ) : (
                <ChevronRight className="h-3.5 w-3.5 text-muted-foreground" />
              )}
            </button>
          ) : (
            <span className="w-[18px]" />
          )}
          <Badge
            variant="secondary"
            className={`text-xs ${getCategoryColorClass(node.color)}`}
          >
            {node.name}
          </Badge>
          {node.description && (
            <span className="text-xs text-muted-foreground truncate max-w-[200px]">
              {node.description}
            </span>
          )}
          <div className="ml-auto flex gap-1 opacity-0 group-hover:opacity-100 transition-opacity">
            <Button
              type="button"
              variant="ghost"
              size="icon"
              className="h-6 w-6"
              onClick={() => handleEdit(node)}
            >
              <Pencil className="h-3 w-3" />
            </Button>
            <Button
              type="button"
              variant="ghost"
              size="icon"
              className="h-6 w-6 text-destructive"
              onClick={() => handleDelete(node.id, node.name)}
              disabled={isDeleting}
            >
              <Trash2 className="h-3 w-3" />
            </Button>
          </div>
        </div>
        {hasChildren && isExpanded && node.children.map(renderNode)}
      </div>
    );
  };

  return (
    <DetailSheet
      open={open}
      onOpenChange={onOpenChange}
      size="md"
      title={
        <span className="flex items-center gap-2">
          <FolderTree className="h-5 w-5" />
          Product Categories
        </span>
      }
      description="Create and manage hierarchical product categories."
    >
      <div className="space-y-4">
        {showForm && (
          <div className="space-y-3 rounded-md border p-3 bg-muted/30">
            <div className="space-y-1.5">
              <Label className="text-xs">Name *</Label>
              <Input
                value={formName}
                onChange={(e) => setFormName(e.target.value)}
                placeholder="e.g. Computers"
                autoFocus
              />
            </div>
            <div className="space-y-1.5">
              <Label className="text-xs">Description</Label>
              <Input
                value={formDescription}
                onChange={(e) => setFormDescription(e.target.value)}
                placeholder="Optional description..."
              />
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-1.5">
                <Label className="text-xs">Parent</Label>
                <Select
                  value={formParentId || "none"}
                  onValueChange={(v) => setFormParentId(v === "none" ? null : v)}
                >
                  <SelectTrigger className="text-xs h-8">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="none">None (top-level)</SelectItem>
                    {flatTreeList
                      .filter((c) => c.id !== editingId)
                      .map((cat) => (
                        <SelectItem key={cat.id} value={cat.id}>
                          {"— ".repeat(cat.depth)}{cat.name}
                        </SelectItem>
                      ))}
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-1.5">
                <Label className="text-xs">Color</Label>
                <Select
                  value={formColor || "none"}
                  onValueChange={(v) => setFormColor(v === "none" ? null : v)}
                >
                  <SelectTrigger className="text-xs h-8">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="none">Default</SelectItem>
                    {COLORS.map((c) => (
                      <SelectItem key={c.value} value={c.value}>
                        <span className="flex items-center gap-1.5">
                          <span className={`inline-block w-2.5 h-2.5 rounded-full ${COLOR_CLASSES[c.value]?.split(" ")[0]}`} />
                          {c.label}
                        </span>
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            </div>
            <div className="flex gap-2">
              <Button
                type="button"
                size="sm"
                onClick={handleSubmit}
                disabled={!formName.trim() || isCreating}
              >
                {isCreating && <Loader2 className="mr-1 h-3 w-3 animate-spin" />}
                {editingId ? "Save" : "Create"}
              </Button>
              <Button type="button" size="sm" variant="ghost" onClick={resetForm}>
                Cancel
              </Button>
            </div>
          </div>
        )}

        <ScrollArea className="max-h-[60vh]">
          {categoryTree.length === 0 ? (
            <div className="flex flex-col items-center py-8 text-center">
              <FolderTree className="h-10 w-10 text-muted-foreground mb-3" />
              <p className="text-sm text-muted-foreground">No categories yet</p>
              <p className="text-xs text-muted-foreground">Create your first category to organize products.</p>
            </div>
          ) : (
            <div className="space-y-0.5">{categoryTree.map(renderNode)}</div>
          )}
        </ScrollArea>

        {!showForm && (
          <Button
            type="button"
            variant="outline"
            onClick={() => {
              resetForm();
              setShowForm(true);
            }}
            className="w-full"
          >
            <Plus className="mr-2 h-4 w-4" />
            New Category
          </Button>
        )}
      </div>
    </DetailSheet>
  );
}
