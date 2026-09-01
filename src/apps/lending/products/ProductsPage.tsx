/**
 * Lending → Loan products (C4).
 *
 * A product is an identity; its commercial terms are published as immutable
 * versions. This page lists products and opens the two dialogs — it never
 * computes pricing, which the schedule engine (C6) derives server-side from
 * the version a loan snapshots.
 */

import { useMemo, useState } from "react";
import { History, Plus } from "lucide-react";
import {
  PageHeader,
  PageBody,
  Section,
  FilterBar,
  EmptyState,
  LoadingState,
  ErrorState,
  StatusBadge,
} from "@/design-system";
import { Button } from "@/components/ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import {
  MF_PRODUCT_STATUSES,
  useMfLoanProducts,
  type MfLoanProduct,
  type MfProductStatus,
} from "@/hooks/useMfLoanProducts";
import { ProductFormDialog } from "./ProductFormDialog";
import { ProductVersionDialog } from "./ProductVersionDialog";

const STATUS_TONE: Record<MfProductStatus, "neutral" | "success" | "warning" | "danger"> = {
  draft: "warning",
  active: "success",
  retired: "neutral",
};

export function ProductsPage() {
  const [status, setStatus] = useState<MfProductStatus | "all">("all");
  const [search, setSearch] = useState("");
  const [editing, setEditing] = useState<MfLoanProduct | null>(null);
  const [formOpen, setFormOpen] = useState(false);
  const [versionProduct, setVersionProduct] = useState<MfLoanProduct | null>(null);
  const [versionOpen, setVersionOpen] = useState(false);

  const { products, isLoading, error, createProduct, updateProduct, businessId } =
    useMfLoanProducts({ status });

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return products;
    return products.filter((p) =>
      [p.code, p.name, p.description]
        .filter(Boolean)
        .some((v) => String(v).toLowerCase().includes(q)),
    );
  }, [products, search]);

  const openCreate = () => {
    setEditing(null);
    setFormOpen(true);
  };

  const openEdit = (product: MfLoanProduct) => {
    setEditing(product);
    setFormOpen(true);
  };

  const openVersions = (product: MfLoanProduct) => {
    setVersionProduct(product);
    setVersionOpen(true);
  };

  return (
    <>
      <PageHeader
        eyebrow="Lending"
        title="Loan products"
        description="Product identity with immutable priced versions — repricing publishes a new version, never edits a live one."
        actions={
          <Button size="sm" onClick={openCreate}>
            <Plus className="mr-1.5 h-4 w-4" />
            New product
          </Button>
        }
      />
      <PageBody>
        <Section title="Products" description={`${filtered.length} product(s)`}>
          <FilterBar
            search={search}
            onSearchChange={setSearch}
            placeholder="Search code, name or description…"
          >
            <Select
              value={status}
              onValueChange={(v) => setStatus(v as MfProductStatus | "all")}
            >
              <SelectTrigger className="h-8 w-[150px] text-sm">
                <SelectValue placeholder="All statuses" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All statuses</SelectItem>
                {MF_PRODUCT_STATUSES.map((s) => (
                  <SelectItem key={s} value={s}>
                    {s}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </FilterBar>

          {error ? (
            <ErrorState description={error.message} />
          ) : isLoading ? (
            <LoadingState />
          ) : filtered.length === 0 ? (
            <EmptyState
              title="No loan products yet"
              description="Create a product, then publish its first priced version before it can be lent on."
              action={<Button onClick={openCreate}>New product</Button>}
            />
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Code</TableHead>
                  <TableHead>Name</TableHead>
                  <TableHead>Description</TableHead>
                  <TableHead>Pricing</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead className="text-right">Versions</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {filtered.map((p) => (
                  <TableRow
                    key={p.id}
                    className="cursor-pointer"
                    onClick={() => openEdit(p)}
                  >
                    <TableCell className="font-mono text-xs">{p.code}</TableCell>
                    <TableCell className="font-medium">{p.name}</TableCell>
                    <TableCell className="max-w-[320px] truncate text-muted-foreground">
                      {p.description ?? "—"}
                    </TableCell>
                    <TableCell>
                      {p.current_version_id ? (
                        <StatusBadge tone="success">Version in force</StatusBadge>
                      ) : (
                        <StatusBadge tone="warning">Not priced</StatusBadge>
                      )}
                    </TableCell>
                    <TableCell>
                      <StatusBadge tone={STATUS_TONE[p.status]}>{p.status}</StatusBadge>
                    </TableCell>
                    <TableCell className="text-right">
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={(e) => {
                          e.stopPropagation();
                          openVersions(p);
                        }}
                      >
                        <History className="mr-1.5 h-3.5 w-3.5" />
                        Versions
                      </Button>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </Section>
      </PageBody>

      <ProductFormDialog
        open={formOpen}
        onOpenChange={setFormOpen}
        product={editing}
        existingProducts={products}
        onCreate={async (input) => {
          await createProduct.mutateAsync(input);
        }}
        onUpdate={async (id, patch) => {
          await updateProduct.mutateAsync({ id, ...patch });
        }}
      />

      <ProductVersionDialog
        open={versionOpen}
        onOpenChange={setVersionOpen}
        product={versionProduct}
        businessId={businessId}
      />
    </>
  );
}

export default ProductsPage;
