/**
 * MonospacePreview — Phase A.3 WYSIWYG receipt renderer.
 *
 * Renders the output of `buildReceiptLines` into a fixed-column monospace
 * surface so the on-screen receipt matches the thermal printer's column
 * grid exactly (paper width × font ⇒ columns). NO flexbox column hacks,
 * NO ad-hoc spacing — every cell is a real character.
 *
 * The inner element is a styled `<pre>` with a width set to
 * `${columns}ch` which, with a true monospace font, reproduces the
 * character cell of the printer at any zoom level. Bold and centre / right
 * alignment come from `LineMeta`, never inferred.
 */

import { useMemo } from "react";
import type { LineMeta } from "@/lib/receipt/preview/buildReceiptLines";

export interface MonospacePreviewProps {
  lines: string[];
  meta: LineMeta[];
  columns: number;
  marginCols: number;
  paper: "40mm" | "58mm" | "80mm";
  /** QR data url to render where meta.qr === true (single QR per receipt). */
  qrDataUrl?: string | null;
  className?: string;
}

function padCenter(s: string, width: number): string {
  if (s.length >= width) return s.slice(0, width);
  const total = width - s.length;
  const l = Math.floor(total / 2);
  return " ".repeat(l) + s + " ".repeat(total - l);
}

function padRight(s: string, width: number): string {
  if (s.length >= width) return s.slice(0, width);
  return " ".repeat(width - s.length) + s;
}

export function MonospacePreview({
  lines,
  meta,
  columns,
  marginCols,
  paper,
  qrDataUrl,
  className,
}: MonospacePreviewProps) {
  // Pre-render every row to a fixed-width string so the visual alignment
  // mirrors the printer (no flex spacing, no kerning surprises).
  const rendered = useMemo(() => {
    return lines.map((raw, i) => {
      const m = meta[i] ?? { align: "left" as const };
      if (m.qr) return { kind: "qr" as const, m };
      const inner = raw ?? "";
      let text: string;
      if (m.align === "center") text = padCenter(inner, columns);
      else if (m.align === "right") text = padRight(inner, columns);
      else text = inner.length >= columns ? inner.slice(0, columns) : inner + " ".repeat(columns - inner.length);
      return { kind: "text" as const, m, text };
    });
  }, [lines, meta, columns]);

  // Fixed character-cell rendering. Width = columns × ch. We keep the
  // surface-paper feel (white background, faint shadow) but the typography
  // is non-negotiable monospace so the column grid is real.
  return (
    <div
      className={className}
      style={{
        background: "white",
        color: "black",
        boxShadow: "0 4px 14px rgba(0,0,0,0.08)",
        borderRadius: 4,
        padding: "12px 8px",
        display: "inline-block",
      }}
      data-testid="monospace-preview"
      data-paper={paper}
      data-columns={columns}
      data-margin-cols={marginCols}
    >
      <pre
        style={{
          margin: 0,
          fontFamily:
            "'JetBrains Mono', ui-monospace, SFMono-Regular, Menlo, Consolas, monospace",
          fontSize: paper === "80mm" ? 11.5 : 10.5,
          lineHeight: 1.25,
          width: `${columns}ch`,
          whiteSpace: "pre",
          tabSize: 1,
        }}
      >
        {rendered.map((row, i) => {
          if (row.kind === "qr") {
            return (
              <div
                key={i}
                style={{ textAlign: "center", padding: "6px 0" }}
              >
                {qrDataUrl ? (
                  <img
                    src={qrDataUrl}
                    alt="QR"
                    style={{ width: 96, height: 96, imageRendering: "pixelated" }}
                  />
                ) : (
                  <div
                    style={{
                      width: 96,
                      height: 96,
                      margin: "0 auto",
                      background:
                        "repeating-conic-gradient(#000 0% 25%, #fff 0% 50%) 0 / 12px 12px",
                      border: "1px solid #000",
                    }}
                  />
                )}
              </div>
            );
          }
          const style: React.CSSProperties = {};
          if (row.m.bold) style.fontWeight = 700;
          if (row.m.large) style.fontSize = paper === "80mm" ? 14 : 13;
          if (row.m.rule) style.color = "#444";
          return (
            <div key={i} style={style}>
              {row.text || "\u00A0"}
            </div>
          );
        })}
      </pre>
    </div>
  );
}
