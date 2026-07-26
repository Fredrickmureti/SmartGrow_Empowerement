/**
 * AuditLogTableView — shared presentational table for every audit-log surface.
 *
 * Used by the Activity, Settings changes and Legal orders tabs on the
 * /settings/audit-logs page so all three read identically:
 *   • same columns (When · User · Action · Entity · Name · What happened)
 *   • same skeleton / empty state
 *   • same row-click → drawer interaction
 *   • same pagination widget
 *
 * Server pagination: pass `pagination` + `onPageChange`/`onPageSizeChange`.
 * Client pagination: omit those; the component paginates the provided
 * `entries` in-memory using `defaultPageSize`.
 */
import { useMemo, useState, useEffect } from "react";
import { format } from "date-fns";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { StatusBadge } from "@/design-system";
import { Eye, History, Loader2 } from "lucide-react";
import { DataTablePagination } from "@/components/common/DataTablePagination";
import type { PaginationMeta } from "@/hooks/usePaginatedQuery";

export type AuditActionTone = React.ComponentProps<typeof StatusBadge>["tone"];

export interface AuditEntry {
  /** Stable row key. */
  id: string;
  /** ISO string used for the "When" column. */
  occurredAt: string;
  /** Resolved display name; falls back to "System" when null. */
  userLabel: string | null;
  /** Coloured action pill. */
  action: { label: string; tone: AuditActionTone };
  /** Entity / kind badge; raw is shown as tooltip. */
  entity: { label: string; raw?: string };
  /** Record name (invoice number, setting key, order reference …). */
  entityName: string | null;
  /** One-line "what happened" summary. */
  summary: string;
  /** Opaque payload handed back to the drawer renderer. */
  raw: unknown;
}

interface Props {
  entries: AuditEntry[];
  isLoading?: boolean;
  isFetching?: boolean;
  onSelect: (entry: AuditEntry) => void;
  /** Server-side pagination. When omitted, the view paginates in-memory. */
  pagination?: PaginationMeta;
  onPageChange?: (page: number) => void;
  onPageSizeChange?: (size: number) => void;
  defaultPageSize?: number;
  emptyTitle?: string;
  emptyHint?: string;
}

export function AuditLogTableView({
  entries,
  isLoading = false,
  isFetching = false,
  onSelect,
  pagination,
  onPageChange,
  onPageSizeChange,
  defaultPageSize = 25,
  emptyTitle = "No audit entries found",
  emptyHint = "Changes will be recorded here",
}: Props) {
  // Client-side pagination fallback for callers that hand over the full list.
  const [clientPage, setClientPage] = useState(1);
  const [clientPageSize, setClientPageSize] = useState(defaultPageSize);
  useEffect(() => {
    // Snap back to first page when the underlying dataset shrinks.
    setClientPage(1);
  }, [entries.length]);

  const clientPagination: PaginationMeta = useMemo(() => {
    const totalCount = entries.length;
    const totalPages = Math.max(1, Math.ceil(totalCount / clientPageSize));
    const page = Math.min(clientPage, totalPages);
    return {
      page,
      pageSize: clientPageSize,
      totalCount,
      totalPages,
      hasNextPage: page < totalPages,
      hasPreviousPage: page > 1,
    };
  }, [entries.length, clientPage, clientPageSize]);

  const activePagination = pagination ?? clientPagination;
  const handlePageChange = onPageChange ?? setClientPage;
  const handlePageSizeChange = onPageSizeChange ?? setClientPageSize;

  const visible = useMemo(() => {
    if (pagination) return entries; // server already sliced
    const start = (clientPagination.page - 1) * clientPagination.pageSize;
    return entries.slice(start, start + clientPagination.pageSize);
  }, [entries, pagination, clientPagination]);

  return (
    <>
      <Card>
        <CardContent className="p-0">
          {isLoading ? (
            <div className="flex items-center justify-center py-12">
              <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
            </div>
          ) : entries.length === 0 ? (
            <div className="flex flex-col items-center justify-center py-12 text-center">
              <History className="h-12 w-12 text-muted-foreground mb-4" />
              <h3 className="text-lg font-medium">{emptyTitle}</h3>
              <p className="text-muted-foreground">{emptyHint}</p>
            </div>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>When</TableHead>
                  <TableHead>User</TableHead>
                  <TableHead>Action</TableHead>
                  <TableHead>Entity</TableHead>
                  <TableHead>Name</TableHead>
                  <TableHead className="max-w-xs">What happened</TableHead>
                  <TableHead className="w-12" />
                </TableRow>
              </TableHeader>
              <TableBody>
                {visible.map((entry) => (
                  <TableRow
                    key={entry.id}
                    className="cursor-pointer"
                    onClick={() => onSelect(entry)}
                  >
                    <TableCell className="whitespace-nowrap text-sm">
                      {format(new Date(entry.occurredAt), "MMM d, yyyy HH:mm")}
                    </TableCell>
                    <TableCell className="text-sm">
                      {entry.userLabel || "System"}
                    </TableCell>
                    <TableCell>
                      <StatusBadge tone={entry.action.tone}>
                        {entry.action.label}
                      </StatusBadge>
                    </TableCell>
                    <TableCell>
                      <Badge variant="outline" title={entry.entity.raw ?? entry.entity.label}>
                        {entry.entity.label}
                      </Badge>
                    </TableCell>
                    <TableCell className="font-medium">
                      {entry.entityName || "—"}
                    </TableCell>
                    <TableCell className="max-w-xs truncate text-muted-foreground">
                      {entry.summary}
                    </TableCell>
                    <TableCell>
                      <Button
                        variant="ghost"
                        size="icon"
                        onClick={(e) => {
                          e.stopPropagation();
                          onSelect(entry);
                        }}
                      >
                        <Eye className="h-4 w-4" />
                      </Button>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>
      {entries.length > 0 && (
        <DataTablePagination
          pagination={activePagination}
          onPageChange={handlePageChange}
          onPageSizeChange={handlePageSizeChange}
          isLoading={isFetching}
        />
      )}
    </>
  );
}
