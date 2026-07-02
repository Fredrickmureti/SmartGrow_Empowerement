import { useState, useCallback, useMemo } from "react";

interface UseBulkSelectionOptions<T> {
  items: T[];
  getItemId: (item: T) => string;
}

export function useBulkSelection<T>({ items, getItemId }: UseBulkSelectionOptions<T>) {
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());

  const allIds = useMemo(() => items.map(getItemId), [items, getItemId]);

  const isAllSelected = useMemo(
    () => allIds.length > 0 && allIds.every((id) => selectedIds.has(id)),
    [allIds, selectedIds]
  );

  const isPartiallySelected = useMemo(
    () => allIds.some((id) => selectedIds.has(id)) && !isAllSelected,
    [allIds, selectedIds, isAllSelected]
  );

  const selectedCount = useMemo(
    () => allIds.filter((id) => selectedIds.has(id)).length,
    [allIds, selectedIds]
  );

  const selectedItems = useMemo(
    () => items.filter((item) => selectedIds.has(getItemId(item))),
    [items, selectedIds, getItemId]
  );

  const toggleItem = useCallback((id: string) => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) {
        next.delete(id);
      } else {
        next.add(id);
      }
      return next;
    });
  }, []);

  const toggleAll = useCallback(() => {
    if (isAllSelected) {
      // Deselect all current page items
      setSelectedIds((prev) => {
        const next = new Set(prev);
        allIds.forEach((id) => next.delete(id));
        return next;
      });
    } else {
      // Select all current page items
      setSelectedIds((prev) => {
        const next = new Set(prev);
        allIds.forEach((id) => next.add(id));
        return next;
      });
    }
  }, [isAllSelected, allIds]);

  const clearSelection = useCallback(() => {
    setSelectedIds(new Set());
  }, []);

  const isSelected = useCallback(
    (id: string) => selectedIds.has(id),
    [selectedIds]
  );

  return {
    selectedIds,
    selectedCount,
    selectedItems,
    isAllSelected,
    isPartiallySelected,
    toggleItem,
    toggleAll,
    clearSelection,
    isSelected,
  };
}
