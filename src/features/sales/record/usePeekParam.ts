/**
 * usePeekParam — the standard way a Sales list opens a DetailSheet peek
 * for one of its records via `?peek=<id>`.
 *
 *   const [peekId, setPeek] = usePeekParam();
 *   <DetailSheet open={!!peekId} onOpenChange={(o) => !o && setPeek(null)} …>
 *
 * Uses react-router-dom's `useSearchParams` because every Sales list page
 * currently mounts under `SalesLayout` (react-router). When those pages
 * migrate to TanStack Start file routes, swap the impl here — call sites
 * do not change.
 */
import { useCallback } from "react";
import { useSearchParams } from "react-router-dom";

const PARAM = "peek";

export function usePeekParam(): [string | null, (id: string | null) => void] {
  const [params, setParams] = useSearchParams();
  const peekId = params.get(PARAM);

  const setPeek = useCallback(
    (id: string | null) => {
      setParams(
        (prev) => {
          const next = new URLSearchParams(prev);
          if (id) next.set(PARAM, id);
          else next.delete(PARAM);
          return next;
        },
        { replace: true },
      );
    },
    [setParams],
  );

  return [peekId, setPeek];
}
