/**
 * Wave 2 — surfacing server lifecycle errors.
 *
 * The project command RPCs raise domain-specific Postgres errors:
 *  - `40001` (serialization_failure) when the row version supplied by the
 *    browser no longer matches the stored `projects.version`.
 *  - `P0002` when the project no longer exists.
 *  - `42501` for authority / field-level governance rejections.
 *  - a plain exception whose message lists closure blockers (open tasks,
 *    unapproved timesheets, uninvoiced billable milestones).
 *
 * They must not reach the user as raw Postgres text.
 */

export interface ProjectCommandError {
  code?: string;
  message?: string;
  details?: string | null;
  hint?: string | null;
}

const VERSION_CONFLICT_MESSAGE =
  "This project was changed by someone else. Reload the project and try again.";

export function isProjectVersionConflict(error: unknown): boolean {
  const code = (error as ProjectCommandError | null)?.code;
  return code === "40001";
}

/**
 * Turns a raw command-RPC error into a sentence a project manager can act on.
 */
export function projectCommandErrorMessage(error: unknown, fallback: string): string {
  const err = (error ?? {}) as ProjectCommandError;
  const raw = (err.message ?? "").trim();

  if (isProjectVersionConflict(error)) return VERSION_CONFLICT_MESSAGE;
  if (err.code === "P0002" || raw === "project_not_found") {
    return "This project no longer exists.";
  }

  if (!raw) return fallback;

  // Closure guards are raised as readable sentences already; keep them.
  if (/cannot be closed|open task|timesheet|milestone|not allowed|only an administrator|cannot be changed|transition/i.test(raw)) {
    return raw;
  }

  if (err.code === "42501") return raw || "You are not allowed to perform this action.";

  return fallback;
}

/**
 * Human-readable list of reasons a project cannot be closed, as returned by
 * the `project_closure_blockers(project_id)` RPC.
 */
export function formatClosureBlockers(blockers: Array<string | { blocker?: string; reason?: string }>): string {
  const lines = blockers
    .map((b) => (typeof b === "string" ? b : (b.reason ?? b.blocker ?? "")))
    .filter(Boolean);
  return lines.length > 0 ? lines.join("; ") : "";
}
