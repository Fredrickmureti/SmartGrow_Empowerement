import { useState } from "react";
import { useProductCategories } from "@/hooks/useProductCategories";
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
import { Plus, Loader2, FolderTree } from "lucide-react";

interface ProductCategorySelectorProps {
  value: string | null;
  onChange: (categoryId: string | null) => void;
  disabled?: boolean;
}

export function ProductCategorySelector({ value, onChange, disabled }: ProductCategorySelectorProps) {
  const { flatTreeList, isLoading, createCategory, isCreating } = useProductCategories();
  const [showCreate, setShowCreate] = useState(false);
  const [newCategoryName, setNewCategoryName] = useState("");
  const [newCategoryParent, setNewCategoryParent] = useState<string | null>(null);

  const handleCreate = async () => {
    if (!newCategoryName.trim()) return;

    try {
      const created = await createCategory({
        name: newCategoryName.trim(),
        parent_id: newCategoryParent,
      });
      onChange(created.id);
      setNewCategoryName("");
      setNewCategoryParent(null);
      setShowCreate(false);
    } catch {
      // Error handled by hook
    }
  };

  if (showCreate) {
    return (
      <div className="space-y-2 rounded-md border p-3 bg-muted/30">
        <Label className="text-xs font-medium">New Category</Label>
        <Input
          placeholder="Category name..."
          value={newCategoryName}
          onChange={(e) => setNewCategoryName(e.target.value)}
          autoFocus
          disabled={isCreating}
        />
        {flatTreeList.length > 0 && (
          <Select
            value={newCategoryParent || "none"}
            onValueChange={(v) => setNewCategoryParent(v === "none" ? null : v)}
          >
            <SelectTrigger className="text-xs h-8">
              <SelectValue placeholder="Parent (optional)" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="none">No parent (top-level)</SelectItem>
              {flatTreeList.map((cat) => (
                <SelectItem key={cat.id} value={cat.id}>
                  {"— ".repeat(cat.depth)}{cat.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        )}
        <div className="flex gap-2">
          <Button
            type="button"
            size="sm"
            onClick={handleCreate}
            disabled={!newCategoryName.trim() || isCreating}
          >
            {isCreating && <Loader2 className="mr-1 h-3 w-3 animate-spin" />}
            Create
          </Button>
          <Button
            type="button"
            size="sm"
            variant="ghost"
            onClick={() => {
              setShowCreate(false);
              setNewCategoryName("");
              setNewCategoryParent(null);
            }}
            disabled={isCreating}
          >
            Cancel
          </Button>
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-2">
      <Label className="flex items-center gap-1.5">
        <FolderTree className="h-3.5 w-3.5" />
        Category
      </Label>
      <div className="flex gap-2">
        <Select
          value={value || "none"}
          onValueChange={(v) => onChange(v === "none" ? null : v)}
          disabled={disabled || isLoading}
        >
          <SelectTrigger className="flex-1">
            <SelectValue placeholder="Select category..." />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="none">No category</SelectItem>
            {flatTreeList.map((cat) => (
              <SelectItem key={cat.id} value={cat.id}>
                {"— ".repeat(cat.depth)}{cat.name}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Button
          type="button"
          variant="outline"
          size="icon"
          onClick={() => setShowCreate(true)}
          title="Create new category"
          disabled={disabled}
        >
          <Plus className="h-4 w-4" />
        </Button>
      </div>
    </div>
  );
}
