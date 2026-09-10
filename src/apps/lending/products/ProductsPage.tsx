/**
 * Lending → Loan products (C4).
 *
 * A product is an identity; its commercial terms are published as immutable
 * versions. This page lists products and opens the two dialogs — it never
 * computes pricing, which the schedule engine (C6) derives server-side from
 * the version a loan snapshots.
 */

import { useMemo, useState } from "react";
import { usePermissions } from "@/hooks/usePermissions";
import { History, MoreHorizontal, Plus } from "lucide-react";
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
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { ConfirmDeleteDialog } from "@/components/shared/ConfirmDeleteDialog";
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
import { ProductDetailSheet } from "./ProductDetailSheet";

const STATUS_TONE: Record<MfProductStatus, "neutral" | "success" | "warning" | "danger"> = {
  draft: "warning",
  active: "success",
  retired: "neutral",
};

export function ProductsPage() {
  const { can } = usePermissions();
  const canManage = can("manageLoanProducts");
  const [status, setStatus] = useState<MfProductStatus | "all">("all");
  const [search, setSearch] = useState("");
  const [editing, setEditing] = useState<MfLoanProduct | null>(null);
  const [formOpen, setFormOpen] = useState(false);
  // Opening a product is a read: the row shows the record, never a form.
  const [viewing, setViewing] = useState<MfLoanProduct | null>(null);
  const [detailOpen, setDetailOpen] = useState(false);
  const [versionProduct, setVersionProduct] = useState<MfLoanProduct | null>(null);
  const [versionOpen, setVersionOpen] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState<MfLoanProduct | null>(null);
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [retireTarget, setRetireTarget] = useState<MfLoanProduct | null>(null);
  const [retireOpen, setRetireOpen] = useState(false);

  const {
    products,
    isLoading,
    error,
    createProduct,
    updateProduct,
    retireProduct,
    deleteProduct,
    businessId,
  } = useMfLoanProducts({ status });

  /**
   * A product that is still being offered and has been priced must be retired
   * before it can go — removal is a deliberate two-step act. A retired or
   * never-priced product may be removed when nothing references it; the
   * database (`mf_delete_loan_product`) refuses when applications or loans
   * exist, so this only shapes the menu.
   */
  const deletable = (p: MfLoanProduct) => !p.current_version_id || p.status === "retired";


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

  const openView = (product: MfLoanProduct) => {
    setViewing(product);
    setDetailOpen(true);
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
          canManage ? (
            <Button size="sm" onClick={openCreate}>
              <Plus className="mr-1.5 h-4 w-4" />
              New product
            </Button>
          ) : undefined
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
              action={canManage ? <Button onClick={openCreate}>New product</Button> : undefined}
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
                    className={canManage ? "cursor-pointer" : undefined}
                    onClick={canManage ? () => openEdit(p) : undefined}
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
                    <TableCell
                      className="space-x-1.5 text-right"
                      onClick={(e) => e.stopPropagation()}
                    >
                      <Button variant="outline" size="sm" onClick={() => openVersions(p)}>
                        <History className="mr-1.5 h-3.5 w-3.5" />
                        Versions
                      </Button>
                      {canManage && (
                        <DropdownMenu>
                          <DropdownMenuTrigger asChild>
                            <Button size="sm" variant="ghost" aria-label="More actions">
                              <MoreHorizontal className="h-4 w-4" />
                            </Button>
                          </DropdownMenuTrigger>
                          <DropdownMenuContent align="end" className="w-64">
                            <DropdownMenuLabel>{p.code}</DropdownMenuLabel>
                            <DropdownMenuItem onClick={() => openEdit(p)}>Edit</DropdownMenuItem>
                            <DropdownMenuItem onClick={() => openVersions(p)}>
                              Versions
                            </DropdownMenuItem>
                            <DropdownMenuSeparator />
                            {p.status !== "retired" && (
                              <DropdownMenuItem
                                onClick={() => {
                                  setRetireTarget(p);
                                  setRetireOpen(true);
                                }}
                              >
                                Retire (stop offering)
                              </DropdownMenuItem>
                            )}
                            {deletable(p) ? (
                              <DropdownMenuItem
                                className="text-destructive focus:text-destructive"
                                onClick={() => {
                                  setDeleteTarget(p);
                                  setDeleteOpen(true);
                                }}
                              >
                                Delete
                              </DropdownMenuItem>
                            ) : (
                              <DropdownMenuItem disabled>
                                Retire it first, then it can be deleted
                              </DropdownMenuItem>
                            )}
                          </DropdownMenuContent>
                        </DropdownMenu>
                      )}
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

      <ConfirmDeleteDialog
        open={deleteOpen}
        onOpenChange={setDeleteOpen}
        title="Delete loan product"
        description={
          deleteTarget
            ? `Delete ${deleteTarget.code} — ${deleteTarget.name}? No application and no loan uses it, so no lending history depends on it. This cannot be undone.`
            : undefined
        }
        isLoading={deleteProduct.isPending}
        onConfirm={() => {
          if (deleteTarget) deleteProduct.mutate(deleteTarget.id);
        }}
      />

      <ConfirmDeleteDialog
        open={retireOpen}
        onOpenChange={setRetireOpen}
        variant="warning"
        title="Retire loan product"
        confirmLabel="Retire"
        description={
          retireTarget
            ? `Stop offering ${retireTarget.code} — ${retireTarget.name}? Existing applications and loans keep the pricing that governed them.`
            : undefined
        }
        isLoading={retireProduct.isPending}
        onConfirm={() => {
          if (retireTarget) retireProduct.mutate(retireTarget.id);
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
