/**
 * Workforce rejection copy.
 *
 * Supervisor actions on tasks and operators are guarded in the database
 * (eligibility, state machine, optimistic concurrency). PostgREST hands the
 * raised exception back as raw text, which is useless on a warehouse floor —
 * this translates each guard into shop-floor language. Never surface the raw
 * SQLSTATE/RPC text.
 */
const REJECTION_COPY: Array<[RegExp, string]> = [
  [/wms_task_stale|wms_operator_stale/, "Someone else just changed this. Refresh the board and try again."],
  [/wms_task_version_required|wms_operator_version_required/, "This screen lost track of the record's revision. Refresh the board and try again."],
  [/wms_task_not_found/, "That task no longer exists — it may have been completed or cancelled."],
  [/operator .* not found/i, "That operator is no longer on the roster."],
  [/operator is not eligible/i, "That operator lacks the skill, certification or equipment for this task."],
  [/cannot reassign task in state/i, "This task is already finished, so it cannot be reassigned."],
  [/cannot release task in state/i, "Only a task somebody is holding can be returned to the pool."],
  [/invalid operator status/i, "That availability value is not one the roster accepts."],
];

export function labourErrorMessage(e: unknown): string {
  const raw =
    typeof e === "object" && e !== null && "message" in e
      ? String((e as { message?: unknown }).message ?? "")
      : "";
  for (const [pattern, copy] of REJECTION_COPY) if (pattern.test(raw)) return copy;
  return raw || "Action rejected";
}
