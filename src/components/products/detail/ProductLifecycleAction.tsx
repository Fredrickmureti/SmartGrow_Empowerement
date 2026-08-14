/**
 * Product lifecycle action — the only UI entry point for a status change.
 *
 * `products.status` is the authoritative lifecycle state (`is_active` is a
 * derived column). Every transition goes through
 * `set_product_lifecycle_status`, which enforces the transition matrix and
 * refuses to archive a product that still holds stock; the copy an operator
 * sees comes from `describeLifecycleFailure`, never a raw SQLSTATE.
 */
import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { MoreHorizontal } from "lucide-react";
import { useToast } from "@/hooks/use-toast";
import {
  allowedProductTransitions,
  productLifecycleLabel,
  setProductLifecycleStatus,
  type ProductLifecycleStatus,
} from "@/features/products/lifecycle/productLifecycle";

interface Props {
  productId: string;
  status?: string | null;
}

export function ProductLifecycleAction({ productId, status }: Props) {
  const { toast } = useToast();
  const qc = useQueryClient();
  const [busy, setBusy] = useState(false);

  const options = allowedProductTransitions(status);
  if (options.length === 0) return null;

  const change = async (next: ProductLifecycleStatus) => {
    setBusy(true);
    try {
      await setProductLifecycleStatus(productId, next);
      toast({
        title: "Status updated",
        description: `This product is now ${productLifecycleLabel(next).toLowerCase()}.`,
      });
      await qc.invalidateQueries({ queryKey: ["product-detail"] });
      await qc.invalidateQueries({ queryKey: ["products"] });
    } catch (e) {
      const operatorCopy =
        e instanceof Error ? e.message : "The product status could not be changed.";
      toast({
        title: "Status not changed",
        description: operatorCopy,
        variant: "destructive",
      });
    } finally {
      setBusy(false);
    }
  };

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button size="icon" variant="ghost" aria-label="Change product status" disabled={busy}>
          <MoreHorizontal className="h-4 w-4" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-56 bg-popover">
        <DropdownMenuLabel>
          Status · {productLifecycleLabel(status)}
        </DropdownMenuLabel>
        <DropdownMenuSeparator />
        {options.map((next) => (
          <DropdownMenuItem key={next} onSelect={() => void change(next)}>
            Mark as {productLifecycleLabel(next).toLowerCase()}
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
