import { useEffect, useMemo, useState } from "react";

type AnchorProps = {
  id: string;
  "data-anchor": string;
  className: string;
};

type Options = {
  /** Prefix used to build the DOM id for each row, e.g. "loan-row-". */
  rowIdPrefix?: string;
};

/**
 * Generic deep-link helper for record lists.
 *
 * A caller can link to `?anchor=<kind>:<id>` (or `#<rowIdPrefix><id>`) and the
 * matching row is highlighted and scrolled into view once on mount.
 */
export function useDrillDownAnchor(kind: string, options: Options = {}) {
  const rowIdPrefix = options.rowIdPrefix ?? `${kind}-`;
  const [targetId, setTargetId] = useState<string | null>(null);

  useEffect(() => {
    if (typeof window === "undefined") return;

    const params = new URLSearchParams(window.location.search);
    const raw = params.get("anchor");
    let id: string | null = null;

    if (raw) {
      const [anchorKind, anchorId] = raw.split(":");
      if (anchorId && anchorKind === kind) id = anchorId;
      else if (!anchorId) id = anchorKind ?? null;
    }

    if (!id && window.location.hash.startsWith(`#${rowIdPrefix}`)) {
      id = window.location.hash.slice(rowIdPrefix.length + 1);
    }

    if (!id) return;
    setTargetId(id);

    const el = document.getElementById(`${rowIdPrefix}${id}`);
    el?.scrollIntoView({ behavior: "smooth", block: "center" });
  }, [kind, rowIdPrefix]);

  return useMemo(
    () => ({
      targetId,
      getAnchorProps: (id: string): AnchorProps => ({
        id: `${rowIdPrefix}${id}`,
        "data-anchor": `${kind}:${id}`,
        className: targetId === id ? "bg-accent/60 transition-colors" : "",
      }),
    }),
    [kind, rowIdPrefix, targetId],
  );
}

export default useDrillDownAnchor;
