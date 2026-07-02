/**
 * Date formatting — single source of truth for the reporting engine.
 */

export function formatDate(input: string | Date | null | undefined): string {
  if (!input) return "";
  const d = typeof input === "string" ? new Date(input) : input;
  if (isNaN(d.getTime())) return String(input);
  return d.toLocaleDateString("en-US", {
    year: "numeric",
    month: "short",
    day: "numeric",
  });
}

/**
 * UTC timestamp string for "Generated:" stamps in PDFs.
 * Format: "2026-04-17 14:23:05 UTC"
 */
export function formatGeneratedStamp(d: Date = new Date()): string {
  return `${d.toISOString().replace("T", " ").substring(0, 19)} UTC`;
}
