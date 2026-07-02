/**
 * Phase 4 P4 — destination-side anchor handler.
 *
 * Pages that drill-down resolver targets land on read a query parameter
 * (e.g. `?loan=abc`, `?entry=xyz`) and want a uniform UX:
 *   1. scroll the matching row into view once data is loaded,
 *   2. briefly highlight it so the eye finds it without thinking,
 *   3. optionally open a drawer / dialog tied to the same id.
 *
 * Centralising the behaviour means every drill-down lands the same way,
 * keeps the resolver / hook in `payslipDrillDown` purely concerned with
 * routing, and avoids per-page bespoke scroll logic drifting out of sync.
 *
 * The hook is *intentionally* render-agnostic — it returns the active id
 * plus a `getAnchorProps(id)` helper that yields `{ id, "data-anchor",
 * className }`. Pages choose how to spend that.
 */
import { useEffect, useMemo, useRef, useState } from "react";
import { useSearchParams } from "react-router-dom";

const HIGHLIGHT_MS = 2400;

export interface AnchorProps {
  id: string;
  "data-anchor": boolean;
  className: string;
}

export function useDrillDownAnchor(
  paramName: string,
  opts?: { ready?: boolean; highlightClassName?: string; rowIdPrefix?: string },
) {
  const [params] = useSearchParams();
  const target = params.get(paramName);
  const ready = opts?.ready ?? true;
  const highlightClassName = opts?.highlightClassName ?? "ring-2 ring-primary/60 bg-primary/5";
  const prefix = opts?.rowIdPrefix ?? `${paramName}-`;
  const [active, setActive] = useState<string | null>(null);
  const scrolled = useRef<string | null>(null);

  useEffect(() => {
    if (!target || !ready) return;
    if (scrolled.current === target) return;
    // Defer one frame so the destination list has actually rendered the row
    // — without this the `getElementById` lookup races React commit.
    const handle = requestAnimationFrame(() => {
      const el = document.getElementById(`${prefix}${target}`);
      if (!el) return;
      scrolled.current = target;
      el.scrollIntoView({ behavior: "smooth", block: "center" });
      setActive(target);
      const timer = window.setTimeout(() => setActive(null), HIGHLIGHT_MS);
      // Stash the timer on the element so navigations away cancel cleanly.
      (el as any).__drillTimer = timer;
    });
    return () => cancelAnimationFrame(handle);
  }, [target, ready, prefix]);

  const getAnchorProps = useMemo(
    () =>
      (id: string): AnchorProps => ({
        id: `${prefix}${id}`,
        "data-anchor": active === id,
        className: active === id ? highlightClassName : "",
      }),
    [active, highlightClassName, prefix],
  );

  return { target, active, getAnchorProps };
}
