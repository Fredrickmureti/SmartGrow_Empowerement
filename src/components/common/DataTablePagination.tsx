import {
  ChevronLeft,
  ChevronRight,
  ChevronsLeft,
  ChevronsRight,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import type { PaginationMeta } from "@/hooks/usePaginatedQuery";

interface DataTablePaginationProps {
  pagination: PaginationMeta;
  onPageChange: (page: number) => void;
  onPageSizeChange?: (size: number) => void;
  pageSizeOptions?: number[];
  showPageSizeSelector?: boolean;
  isLoading?: boolean;
}

export function DataTablePagination({
  pagination,
  onPageChange,
  onPageSizeChange,
  pageSizeOptions = [25, 50, 100],
  showPageSizeSelector = true,
  isLoading = false,
}: DataTablePaginationProps) {
  const { page, pageSize, totalCount, totalPages, hasNextPage, hasPreviousPage } = pagination;

  // Calculate display range
  const from = totalCount === 0 ? 0 : (page - 1) * pageSize + 1;
  const to = Math.min(page * pageSize, totalCount);

  return (
    <div className="flex flex-col gap-3 px-2 py-4 sm:flex-row sm:items-center sm:justify-between">
      <div className="text-xs sm:text-sm text-muted-foreground">
        {from.toLocaleString()}–{to.toLocaleString()} of {totalCount.toLocaleString()}
      </div>

      <div className="flex flex-wrap items-center gap-3 sm:gap-6">
        {showPageSizeSelector && onPageSizeChange && (
          <div className="flex items-center gap-2">
            <span className="text-xs sm:text-sm text-muted-foreground whitespace-nowrap">Rows</span>
            <Select
              value={String(pageSize)}
              onValueChange={(value) => onPageSizeChange(Number(value))}
              disabled={isLoading}
            >
              <SelectTrigger className="h-8 w-[60px] text-xs sm:text-sm">
                <SelectValue placeholder={pageSize} />
              </SelectTrigger>
              <SelectContent>
                {pageSizeOptions.map((size) => (
                  <SelectItem key={size} value={String(size)}>
                    {size}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        )}

        <span className="text-xs sm:text-sm text-muted-foreground whitespace-nowrap">
          {page}/{Math.max(1, totalPages)}
        </span>

        <div className="flex items-center gap-1">
          <Button
            variant="outline"
            size="icon"
            className="h-7 w-7 sm:h-8 sm:w-8"
            onClick={() => onPageChange(1)}
            disabled={!hasPreviousPage || isLoading}
            aria-label="Go to first page"
          >
            <ChevronsLeft className="h-3.5 w-3.5 sm:h-4 sm:w-4" />
          </Button>
          <Button
            variant="outline"
            size="icon"
            className="h-7 w-7 sm:h-8 sm:w-8"
            onClick={() => onPageChange(page - 1)}
            disabled={!hasPreviousPage || isLoading}
            aria-label="Go to previous page"
          >
            <ChevronLeft className="h-3.5 w-3.5 sm:h-4 sm:w-4" />
          </Button>
          <Button
            variant="outline"
            size="icon"
            className="h-7 w-7 sm:h-8 sm:w-8"
            onClick={() => onPageChange(page + 1)}
            disabled={!hasNextPage || isLoading}
            aria-label="Go to next page"
          >
            <ChevronRight className="h-3.5 w-3.5 sm:h-4 sm:w-4" />
          </Button>
          <Button
            variant="outline"
            size="icon"
            className="h-7 w-7 sm:h-8 sm:w-8"
            onClick={() => onPageChange(totalPages)}
            disabled={!hasNextPage || isLoading}
            aria-label="Go to last page"
          >
            <ChevronsRight className="h-3.5 w-3.5 sm:h-4 sm:w-4" />
          </Button>
        </div>
      </div>
    </div>
  );
}
