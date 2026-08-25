/**
 * Architecture guard — Projects server authority (Wave 1).
 *
 * Project identity, configuration, lifecycle and team membership are governed
 * by SECURITY DEFINER command RPCs (`project_create`, `project_update_config`,
 * `project_change_status`, `project_add_member`, `project_remove_member`,
 * `project_archive`). The browser may READ `projects` / `project_members`, but
 * it must never write them directly — a direct `.from("projects").insert/
 * update/delete` bypasses the field-level authority checks (billing config,
 * manager, privacy, branch) that only exist inside those functions.
 */
import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";

const SRC = join(process.cwd(), "src");

const GOVERNED_TABLES = ["projects", "project_members"];

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    const st = statSync(full);
    if (st.isDirectory()) {
      if (entry === "node_modules" || entry.startsWith(".")) continue;
      walk(full, out);
    } else if (/\.(ts|tsx)$/.test(entry) && !/\.test\.tsx?$/.test(entry)) {
      out.push(full);
    }
  }
  return out;
}

/**
 * Matches `.from("projects")` followed — within the same statement chain — by
 * a mutating call. Reads (`.select`) are allowed and intentionally untouched.
 */
function findDirectWrites(source: string): string[] {
  const hits: string[] = [];
  for (const table of GOVERNED_TABLES) {
    const re = new RegExp(
      `\\.from\\(\\s*["'\`]${table}["'\`]\\s*\\)[\\s\\S]{0,400}?\\.(insert|update|upsert|delete)\\s*\\(`,
      "g",
    );
    let match: RegExpExecArray | null;
    while ((match = re.exec(source)) !== null) {
      hits.push(`${table}.${match[1]}()`);
    }
  }
  return hits;
}

describe("architecture: projects server authority", () => {
  it("no client file writes projects or project_members directly", () => {
    const offenders: string[] = [];

    for (const file of walk(SRC)) {
      const source = readFileSync(file, "utf8");
      if (!source.includes(".from(")) continue;
      const hits = findDirectWrites(source);
      if (hits.length > 0) {
        offenders.push(`${relative(SRC, file)} → ${[...new Set(hits)].join(", ")}`);
      }
    }

    expect(
      offenders,
      `Direct writes to governed project tables found. Use the project_* command RPCs instead:\n${offenders.join("\n")}`,
    ).toEqual([]);
  });

  it("useProjects routes mutations through the command RPCs", () => {
    const source = readFileSync(join(SRC, "hooks/projects/useProjects.ts"), "utf8");
    for (const rpc of [
      "project_create",
      "project_update_config",
      "project_change_status",
      "project_add_member",
      "project_remove_member",
      "project_archive",
    ]) {
      expect(source, `useProjects must call ${rpc}`).toContain(rpc);
    }
  });
});

/**
 * Wave 2 — task lifecycle authority.
 *
 * `is_done`, `stage_id`, `assigned_to` and `completed_at` on `project_tasks`
 * are lifecycle state, not editable columns: they are owned by
 * `project_task_complete` / `project_task_reopen` / `project_task_move_stage` /
 * `project_task_assign`, which enforce write access, project-not-closed and
 * dependency ordering. A direct table write bypasses all of that.
 */
const TASK_LIFECYCLE_FIELDS = ["is_done", "stage_id", "assigned_to", "completed_at"];

function findTaskLifecycleWrites(source: string): string[] {
  const hits: string[] = [];
  const re = /\.from\(\s*["'`]project_tasks["'`]\s*\)([\s\S]{0,600}?)\.(insert|update|upsert)\s*\(([\s\S]{0,400}?)\)/g;
  let match: RegExpExecArray | null;
  while ((match = re.exec(source)) !== null) {
    const payload = match[3] ?? "";
    for (const field of TASK_LIFECYCLE_FIELDS) {
      if (new RegExp(`\\b${field}\\s*:`).test(payload)) hits.push(`project_tasks.${match[2]}({ ${field} })`);
    }
  }
  return hits;
}

describe("architecture: project task lifecycle authority", () => {
  it("no client file writes task lifecycle columns directly", () => {
    const offenders: string[] = [];

    for (const file of walk(SRC)) {
      const source = readFileSync(file, "utf8");
      if (!source.includes(`.from("project_tasks")`) && !source.includes(`.from('project_tasks')`)) continue;
      const hits = findTaskLifecycleWrites(source);
      if (hits.length > 0) {
        offenders.push(`${relative(SRC, file)} → ${[...new Set(hits)].join(", ")}`);
      }
    }

    expect(
      offenders,
      `Direct lifecycle writes to project_tasks found. Use the project_task_* command RPCs instead:\n${offenders.join("\n")}`,
    ).toEqual([]);
  });

  it("useProjectTasks routes lifecycle changes through the command RPCs", () => {
    const source = readFileSync(join(SRC, "hooks/projects/useProjectTasks.ts"), "utf8");
    for (const rpc of [
      "project_task_complete",
      "project_task_reopen",
      "project_task_move_stage",
      "project_task_assign",
    ]) {
      expect(source, `useProjectTasks must call ${rpc}`).toContain(rpc);
    }
  });
});
