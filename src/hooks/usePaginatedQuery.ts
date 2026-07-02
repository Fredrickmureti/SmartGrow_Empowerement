import { useState, useCallback, useMemo } from "react";
import { useQuery, useQueryClient, QueryKey } from "@tanstack/react-query";

export interface PaginationState {
  page: number;
  pageSize: number;
}

export interface PaginationMeta {
  page: number;
  pageSize: number;
  totalCount: number;
  totalPages: number;
  hasNextPage: boolean;
  hasPreviousPage: boolean;
}

export interface UsePaginatedQueryOptions<T> {
  queryKey: QueryKey;
  queryFn: (pagination: { from: number; to: number }) => Promise<{ data: T[]; count: number }>;
  initialPage?: number;
  pageSize?: number;
  enabled?: boolean;
}

export interface UsePaginatedQueryResult<T> {
  data: T[];
  isLoading: boolean;
  isFetching: boolean;
  error: Error | null;
  pagination: PaginationMeta;
  setPage: (page: number) => void;
  setPageSize: (size: number) => void;
  nextPage: () => void;
  previousPage: () => void;
  refetch: () => void;
}

export function usePaginatedQuery<T>({
  queryKey,
  queryFn,
  initialPage = 1,
  pageSize: initialPageSize = 50,
  enabled = true,
}: UsePaginatedQueryOptions<T>): UsePaginatedQueryResult<T> {
  const queryClient = useQueryClient();
  const [paginationState, setPaginationState] = useState<PaginationState>({
    page: initialPage,
    pageSize: initialPageSize,
  });

  const { page, pageSize } = paginationState;

  // Calculate range for Supabase
  const from = (page - 1) * pageSize;
  const to = from + pageSize - 1;

  const { data, isLoading, isFetching, error, refetch } = useQuery({
    queryKey: [...queryKey, { page, pageSize }],
    queryFn: async () => {
      const result = await queryFn({ from, to });
      return result;
    },
    enabled,
    placeholderData: (previousData) => previousData,
  });

  const totalCount = data?.count ?? 0;
  const totalPages = Math.ceil(totalCount / pageSize);

  const pagination: PaginationMeta = useMemo(
    () => ({
      page,
      pageSize,
      totalCount,
      totalPages,
      hasNextPage: page < totalPages,
      hasPreviousPage: page > 1,
    }),
    [page, pageSize, totalCount, totalPages]
  );

  const setPage = useCallback((newPage: number) => {
    if (newPage >= 1 && newPage <= Math.max(1, totalPages)) {
      setPaginationState((prev) => ({ ...prev, page: newPage }));
    }
  }, [totalPages]);

  const setPageSize = useCallback((newSize: number) => {
    setPaginationState({ page: 1, pageSize: newSize });
  }, []);

  const nextPage = useCallback(() => {
    if (pagination.hasNextPage) {
      setPage(page + 1);
    }
  }, [pagination.hasNextPage, page, setPage]);

  const previousPage = useCallback(() => {
    if (pagination.hasPreviousPage) {
      setPage(page - 1);
    }
  }, [pagination.hasPreviousPage, page, setPage]);

  return {
    data: data?.data ?? [],
    isLoading,
    isFetching,
    error: error as Error | null,
    pagination,
    setPage,
    setPageSize,
    nextPage,
    previousPage,
    refetch: () => refetch(),
  };
}

// Helper function to calculate Supabase range
export function calculateRange(page: number, pageSize: number): { from: number; to: number } {
  const from = (page - 1) * pageSize;
  const to = from + pageSize - 1;
  return { from, to };
}
