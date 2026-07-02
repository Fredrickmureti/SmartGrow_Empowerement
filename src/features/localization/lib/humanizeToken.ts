/**
 * Convert a token_path like "employee.full_name" into a human label
 * "Employee — Full Name". Used by the chip-based template editor and
 * preview surface so admins never read raw dotted token identifiers.
 */
export function humanizeToken(path: string, description?: string | null): string {
  if (description && description.trim().length > 0) return description.trim();
  const parts = path.split(".");
  const titled = parts.map((p) =>
    p
      .replace(/_/g, " ")
      .replace(/\b\w/g, (c) => c.toUpperCase()),
  );
  if (titled.length === 1) return titled[0];
  return `${titled[0]} — ${titled.slice(1).join(" ")}`;
}
