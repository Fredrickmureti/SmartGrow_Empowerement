/**
 * Packaging Master workspace (ADR 0105, Phase 7).
 *
 * Replaces the legacy carton-type CRUD table. Master/detail:
 * a virtualisable TanStack Table grid of every packaging type on the left,
 * a tabbed record on the right (specification, carrier rules, warehouse
 * availability, activity journal). Writes never touch the table — they go
 * through `wms_packaging_*` RPCs.
 */
import { useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import {
  flexRender,
  getCoreRowModel,
  getFilteredRowModel,
  getSortedRowModel,
  useReactTable,
  type ColumnDef,
  type SortingState,
} from "@tanstack/react-table";
import { toast } from "sonner";
import {
  PageHeader, PageBody, FilterBar, LoadingState, EmptyState, StatusBadge, Section,
} from "@/design-system";
import { Button } from "@/components/ui/button";
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from "@/components/ui/select";
import { Box, Plus } from "lucide-react";
import { cn } from "@/lib/utils";
import { useBusinesses } from "@/hooks/useBusinesses";
import {
  LIFECYCLE_TONE, PACKAGING_CLASSES, PACKAGING_LIFECYCLES,
  packagingErrorMessage, usableVolumeCm3, useArchivePackaging,
  usePackagingTypes, useSetPackagingLifecycle,
  type PackagingLifecycle, type PackagingType,
} from "../packagingMaster";
import { PackagingPreview } from "./PackagingPreview";
import { EntityPreviewEmpty } from "@/features/warehouse/entity/EntityPreview";
import { useEntitySelection } from "@/features/warehouse/entity/useEntitySelection";

const ALL = "__all__";

export default function PackagingMasterWorkspace() {
  const { currentBusiness } = useBusinesses();
  const businessId = currentBusiness?.id;
  const { data: rows, isLoading } = usePackagingTypes(businessId);

  const [search, setSearch] = useState("");
  const [classFilter, setClassFilter] = useState<string>(ALL);
  const [lifecycleFilter, setLifecycleFilter] = useState<string>("active_only");
  const [sorting, setSorting] = useState<SortingState>([{ id: "code", desc: false }]);
  const [selectedId, setSelectedId] = useEntitySelection();
  const navigate = useNavigate();

  const setLifecycle = useSetPackagingLifecycle();
  const archive = useArchivePackaging();

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    return (rows ?? []).filter((r) => {
      if (classFilter !== ALL && r.packaging_class !== classFilter) return false;
      if (lifecycleFilter === "active_only" && r.lifecycle_status === "retired") return false;
      if (lifecycleFilter !== "active_only" && lifecycleFilter !== ALL &&
          r.lifecycle_status !== lifecycleFilter) return false;
      if (!q) return true;
      return `${r.code} ${r.name} ${r.material ?? ""}`.toLowerCase().includes(q);
    });
  }, [rows, search, classFilter, lifecycleFilter]);

  const columns = useMemo<ColumnDef<PackagingType>[]>(
    () => [
      {
        accessorKey: "code",
        header: "Code",
        cell: ({ row }) => (
          <div className="min-w-0">
            <p className="truncate font-medium">{row.original.code}</p>
            <p className="truncate text-xs text-muted-foreground">{row.original.name}</p>
          </div>
        ),
      },
      {
        accessorKey: "packaging_class",
        header: "Class",
        cell: ({ getValue }) => (
          <span className="capitalize text-muted-foreground">{String(getValue())}</span>
        ),
      },
      {
        id: "inner",
        header: "Inner (cm)",
        cell: ({ row }) => (
          <span className="tabular-nums text-muted-foreground">
            {row.original.inner_length_cm}×{row.original.inner_width_cm}×{row.original.inner_height_cm}
          </span>
        ),
      },
      {
        id: "usable",
        header: "Usable cm³",
        accessorFn: (r) => usableVolumeCm3(r),
        cell: ({ getValue }) => (
          <span className="tabular-nums">{Math.round(Number(getValue())).toLocaleString()}</span>
        ),
      },
      {
        accessorKey: "max_weight_kg",
        header: "Max kg",
        cell: ({ getValue }) => <span className="tabular-nums">{String(getValue())}</span>,
      },
      {
        accessorKey: "lifecycle_status",
        header: "Lifecycle",
        cell: ({ getValue }) => {
          const v = getValue() as PackagingLifecycle;
          return <StatusBadge tone={LIFECYCLE_TONE[v]}>{v}</StatusBadge>;
        },
      },
    ],
    [],
  );

  const table = useReactTable({
    data: filtered,
    columns,
    state: { sorting },
    onSortingChange: setSorting,
    getCoreRowModel: getCoreRowModel(),
    getSortedRowModel: getSortedRowModel(),
    getFilteredRowModel: getFilteredRowModel(),
  });

  const selected = useMemo(
    () => (rows ?? []).find((r) => r.id === selectedId) ?? null,
    [rows, selectedId],
  );

  const changeLifecycle = (status: PackagingLifecycle) => {
    if (!selected) return;
    setLifecycle.mutate(
      { id: selected.id, status, rowVersion: selected.row_version },
      {
        onSuccess: () => toast.success(`Moved to ${status}`),
        onError: (e) => toast.error(packagingErrorMessage(e)),
      },
    );
  };

  const doArchive = () => {
    if (!selected) return;
    archive.mutate(
      { id: selected.id, reason: "archived from packaging master" },
      {
        onSuccess: (res) => {
          toast.success(res.deleted ? "Packaging deleted" : `Retired — used by ${res.usage_count} carton(s)`);
          if (res.deleted) setSelectedId(null);
        },
        onError: (e) => toast.error(packagingErrorMessage(e)),
      },
    );
  };

  return (
    <>
      <PageHeader
        eyebrow="Warehouse master data"
        title="Packaging catalogue"
        description="Every carton, pallet, tote and envelope the cartonization engine may choose."
        actions={
          <Button onClick={() => navigate("/warehouse-app/packaging/new")}>
            <Plus className="mr-2 h-4 w-4" /> New packaging
          </Button>
        }
      />
      <PageBody>
        <FilterBar search={search} onSearchChange={setSearch} placeholder="Search code, name or material">
          <Select value={classFilter} onValueChange={setClassFilter}>
            <SelectTrigger className="w-full @xl/page:w-[160px]"><SelectValue placeholder="Class" /></SelectTrigger>
            <SelectContent>
              <SelectItem value={ALL}>All classes</SelectItem>
              {PACKAGING_CLASSES.map((c) => (
                <SelectItem key={c} value={c} className="capitalize">{c}</SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Select value={lifecycleFilter} onValueChange={setLifecycleFilter}>
            <SelectTrigger className="w-full @xl/page:w-[170px]"><SelectValue placeholder="Lifecycle" /></SelectTrigger>
            <SelectContent>
              <SelectItem value="active_only">Excluding retired</SelectItem>
              <SelectItem value={ALL}>All lifecycles</SelectItem>
              {PACKAGING_LIFECYCLES.map((l) => (
                <SelectItem key={l} value={l} className="capitalize">{l}</SelectItem>
              ))}
            </SelectContent>
          </Select>
        </FilterBar>

        <div className="min-w-0 grid grid-cols-1 gap-6 xl:grid-cols-[minmax(0,420px)_minmax(0,1fr)]">
          <Section
            title="Catalogue"
            description={`${filtered.length} of ${rows?.length ?? 0} packaging types`}
            contentClassName="p-0"
          >
            {isLoading ? (
              <div className="p-5"><LoadingState rows={6} /></div>
            ) : !filtered.length ? (
              <div className="p-5">
                <EmptyState
                  icon={Box}
                  title="No packaging types"
                  description="Create the boxes, pallets and totes your operation actually uses."
                  action={<Button onClick={() => navigate("/warehouse-app/packaging/new")}><Plus className="mr-2 h-4 w-4" />New packaging</Button>}
                />
              </div>
            ) : (
              <div className="max-h-[70vh] overflow-auto">
                <table className="w-full text-sm">
                  <thead className="sticky top-0 z-10 bg-card">
                    {table.getHeaderGroups().map((hg) => (
                      <tr key={hg.id} className="border-b">
                        {hg.headers.map((h) => (
                          <th
                            key={h.id}
                            onClick={h.column.getToggleSortingHandler()}
                            className="cursor-pointer select-none px-3 py-2 text-left text-xs font-medium text-muted-foreground"
                          >
                            {flexRender(h.column.columnDef.header, h.getContext())}
                            {h.column.getIsSorted() === "asc" ? " ↑" : h.column.getIsSorted() === "desc" ? " ↓" : ""}
                          </th>
                        ))}
                      </tr>
                    ))}
                  </thead>
                  <tbody>
                    {table.getRowModel().rows.map((r) => (
                      <tr
                        key={r.id}
                        onClick={() => setSelectedId(r.original.id)}
                        className={cn(
                          "cursor-pointer border-b last:border-0 hover:bg-muted/50",
                          selectedId === r.original.id && "bg-muted",
                        )}
                      >
                        {r.getVisibleCells().map((c) => (
                          <td key={c.id} className="px-3 py-2 align-middle">
                            {flexRender(c.column.columnDef.cell, c.getContext())}
                          </td>
                        ))}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </Section>

          <Section contentClassName="p-0" className="min-w-0">
            {!selected ? (
              <EntityPreviewEmpty
                title="Select a packaging type"
                description="Pick a row to see its geometry and lifecycle. Full specification, carrier rules, availability and history live on the packaging workspace."
              />
            ) : (
              <PackagingPreview
                record={selected}
                onLifecycleChange={changeLifecycle}
                onArchive={doArchive}
              />
            )}
          </Section>
        </div>
      </PageBody>
    </>
  );
}
