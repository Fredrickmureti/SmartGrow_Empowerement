/**
 * Read-only presentation atoms shared by the lending detail sheets.
 *
 * Presentation only: no data access, no mutation, no business rule. They exist
 * so "show me this record" looks the same for a product, a group and an
 * application instead of each screen inventing its own layout.
 */

import type { ReactNode } from "react";

export function Field({ label, value }: { label: string; value: ReactNode }) {
  return (
    <div className="min-w-0">
      <div className="text-xs text-muted-foreground">{label}</div>
      <div className="break-words text-sm font-medium [overflow-wrap:anywhere]">
        {value === null || value === undefined || value === "" ? "—" : value}
      </div>
    </div>
  );
}

export function Block({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="space-y-3">
      <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
        {title}
      </h3>
      <div className="grid gap-4 sm:grid-cols-2">{children}</div>
    </section>
  );
}
