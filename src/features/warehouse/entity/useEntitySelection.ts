/**
 * useEntitySelection — master/detail selection that lives in the URL.
 *
 * Preview panes are *addressable*: `?sel=<id>` means a supervisor can send
 * "look at this bin" as a link, browser back/forward walks the inspection
 * history, and a refresh does not dump the operator back to an empty pane.
 *
 * Part of the preview-vs-workspace contract (ADR 0122).
 */
import { useCallback } from "react";
import { useSearchParams } from "react-router-dom";

export function useEntitySelection(
  key = "sel",
): [string | null, (id: string | null) => void] {
  const [params, setParams] = useSearchParams();
  const selected = params.get(key);

  const select = useCallback(
    (id: string | null) => {
      setParams(
        (prev) => {
          const next = new URLSearchParams(prev);
          if (id) next.set(key, id);
          else next.delete(key);
          return next;
        },
        { replace: true },
      );
    },
    [key, setParams],
  );

  return [selected, select];
}
