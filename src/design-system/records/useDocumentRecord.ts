/**
 * useDocumentRecord — generic single-record fetcher shared by every
 * Sales entity peek sheet. Each entity wraps this with its typed row +
 * embedded select. Guarantees a single source of truth for the peek
 * surface so peek and object page cannot drift.
 */
import { useEffect, useState } from "react";
import { supabase } from "@/integrations/supabase/client";

interface State<T> {
  record: T | null;
  loading: boolean;
  error: string | null;
}

interface Options {
  /** Table name (e.g. "estimates"). */
  table: string;
  /** PostgREST select including embeds. */
  select: string;
  /** Record id to fetch. `null` clears state without a request. */
  id: string | null | undefined;
  /** Human label used in the "not found" error. */
  entityLabel?: string;
}

export function useDocumentRecord<T>({
  table,
  select,
  id,
  entityLabel = "Record",
}: Options): State<T> {
  const [state, setState] = useState<State<T>>({
    record: null,
    loading: !!id,
    error: null,
  });

  useEffect(() => {
    if (!id) {
      setState({ record: null, loading: false, error: null });
      return;
    }
    let cancelled = false;
    setState((s) => ({ ...s, loading: true, error: null }));
    (async () => {
      // Typed as `any` at this boundary — every caller re-casts to its
      // domain row type. Keeps the generic hook table-agnostic without
      // dragging the entire Database type surface into every peek.
      const { data, error } = await (supabase as any)
        .from(table)
        .select(select)
        .eq("id", id)
        .maybeSingle();
      if (cancelled) return;
      if (error) {
        setState({ record: null, loading: false, error: error.message });
      } else if (!data) {
        setState({
          record: null,
          loading: false,
          error: `${entityLabel} not found.`,
        });
      } else {
        setState({ record: data as T, loading: false, error: null });
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [table, select, id, entityLabel]);

  return state;
}
