/**
 * Loan product identity dialog (C4).
 *
 * Identity only — code, name, description, status. Commercial terms are never
 * edited here; they are published as immutable versions.
 */
import { useEffect, useState } from "react";
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
import { Textarea } from "@/components/ui/textarea";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  MF_PRODUCT_STATUSES,
  nextProductCode,
  type MfLoanProduct,
  type MfLoanProductInput,
  type MfProductStatus,
} from "@/hooks/useMfLoanProducts";

interface ProductFormDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  product: MfLoanProduct | null;
  existingProducts: Array<{ code: string }>;
  onCreate: (input: MfLoanProductInput) => Promise<void>;
  onUpdate: (id: string, patch: Partial<MfLoanProductInput>) => Promise<void>;
}

export function ProductFormDialog({
  open,
  onOpenChange,
  product,
  existingProducts,
  onCreate,
  onUpdate,
}: ProductFormDialogProps) {
  const [code, setCode] = useState("");
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [status, setStatus] = useState<MfProductStatus>("draft");
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!open) return;
    setCode(product?.code ?? nextProductCode(existingProducts));
    setName(product?.name ?? "");
    setDescription(product?.description ?? "");
    setStatus(product?.status ?? "draft");
  }, [open, product, existingProducts]);

  const canSave = code.trim().length > 0 && name.trim().length > 0 && !saving;

  const submit = async () => {
    if (!canSave) return;
    setSaving(true);
    try {
      const payload: MfLoanProductInput = {
        code: code.trim(),
        name: name.trim(),
        description: description.trim() || null,
        status,
      };
      if (product) await onUpdate(product.id, payload);
      else await onCreate(payload);
      onOpenChange(false);
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>{product ? "Edit product" : "New loan product"}</DialogTitle>
          <DialogDescription>
            Product identity only. Amounts, interest, fees and penalties are published
            as immutable versions so live loans are never repriced.
          </DialogDescription>
        </DialogHeader>

        <div className="grid gap-4 py-2">
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1.5">
              <Label htmlFor="product-code">Code</Label>
              <Input
                id="product-code"
                value={code}
                onChange={(e) => setCode(e.target.value)}
                className="font-mono"
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="product-status">Status</Label>
              <Select value={status} onValueChange={(v) => setStatus(v as MfProductStatus)}>
                <SelectTrigger id="product-status">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {MF_PRODUCT_STATUSES.map((s) => (
                    <SelectItem key={s} value={s}>
                      {s}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="product-name">Name</Label>
            <Input
              id="product-name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="e.g. Business Growth Loan"
            />
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="product-description">Description</Label>
            <Textarea
              id="product-description"
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              rows={3}
            />
          </div>
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button onClick={submit} disabled={!canSave}>
            {product ? "Save" : "Create product"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export default ProductFormDialog;
