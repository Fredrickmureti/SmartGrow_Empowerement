import { useState } from 'react';
import { shortId, type IdKind } from '../lib/identity';

interface Props {
  kind: IdKind;
  value?: string | null;
  /** Render the full UUID inline instead of hiding it behind the copy action. */
  expandable?: boolean;
  className?: string;
}

/**
 * The single approved way to put an identifier on screen.
 *
 * Shows the short reference code (`WS-BEBAB9F5`). Clicking copies the full
 * UUID to the clipboard; `expandable` adds a disclosure that reveals it in
 * place for the rare case an operator must read it aloud.
 */
export function IdChip({ kind, value, expandable = false, className }: Props) {
  const [copied, setCopied] = useState(false);
  const [open, setOpen] = useState(false);

  if (!value) return <span className="muted">—</span>;

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(true);
      setTimeout(() => setCopied(false), 1400);
    } catch { /* clipboard unavailable — the disclosure still works */ }
  };

  return (
    <span className={`id-chip-wrap ${className ?? ''}`}>
      <button
        type="button"
        className="id-chip"
        title={`${value} — click to copy`}
        onClick={copy}
      >
        <span className="id-chip-code">{shortId(kind, value)}</span>
        <span className="id-chip-action">{copied ? 'Copied' : 'Copy'}</span>
      </button>
      {expandable && (
        <button type="button" className="id-chip-toggle" onClick={() => setOpen((v) => !v)}>
          {open ? 'Hide full ID' : 'Full ID'}
        </button>
      )}
      {expandable && open && <span className="id-chip-full">{value}</span>}
    </span>
  );
}