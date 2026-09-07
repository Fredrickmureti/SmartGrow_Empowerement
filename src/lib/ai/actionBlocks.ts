/**
 * Action Block protocol — line-prefixed JSON the AI assistant emits to
 * request UI actions. Survives streaming chunk boundaries because each
 * action lives on its own line.
 *
 * Wire format (one per line):
 *   ::action {"type":"open_path","path_id":"payroll.gl_mappings","label":"Open GL Mapping fixer"}
 *   ::action {"type":"fix_gl_mappings","label":"Apply all suggested mappings"}
 *
 * The server validates `path_id` against ROUTE_CATALOG before forwarding.
 * The client renders each action as a Button.
 */

import { isCatalogId, type RouteCatalogId } from "./routeCatalog";

export type ActionBlock =
  | {
      type: "open_path";
      path_id: RouteCatalogId;
      label: string;
    }
  | {
      type: "open_install_dialog";
      app_id: string;
      label: string;
    };

export interface ParsedAssistantContent {
  /** Markdown text with action lines stripped out. */
  text: string;
  /** Validated, ordered action blocks. */
  actions: ActionBlock[];
}

const ACTION_PREFIX = "::action ";

function validate(raw: any): ActionBlock | null {
  if (!raw || typeof raw !== "object" || typeof raw.type !== "string") return null;
  switch (raw.type) {
    case "open_path":
      if (typeof raw.path_id === "string" && isCatalogId(raw.path_id) && typeof raw.label === "string") {
        return { type: "open_path", path_id: raw.path_id as RouteCatalogId, label: raw.label };
      }
      return null;
    case "open_install_dialog":
      if (typeof raw.app_id === "string" && typeof raw.label === "string") {
        return { type: "open_install_dialog", app_id: raw.app_id, label: raw.label };
      }
      return null;
    default:
      return null;
  }
}

/**
 * Parse a streamed/finalized assistant message: strip `::action` lines,
 * keep only validated action blocks, return clean markdown for rendering.
 */
export function parseAssistantContent(content: string): ParsedAssistantContent {
  if (!content || !content.includes(ACTION_PREFIX)) {
    return { text: content ?? "", actions: [] };
  }
  const out: string[] = [];
  const actions: ActionBlock[] = [];
  for (const line of content.split("\n")) {
    const trimmed = line.trimStart();
    if (trimmed.startsWith(ACTION_PREFIX)) {
      const json = trimmed.slice(ACTION_PREFIX.length).trim();
      try {
        const parsed = JSON.parse(json);
        const v = validate(parsed);
        if (v) actions.push(v);
      } catch {
        /* ignore malformed action lines */
      }
      continue;
    }
    out.push(line);
  }
  return { text: out.join("\n").trim(), actions };
}

/**
 * The protocol description we inject into the assistant's system prompt.
 * Keep concise — the model follows examples better than rules.
 */
export const ACTION_BLOCK_PROTOCOL_PROMPT = `
ACTION BLOCKS (very important):
When you want the user to perform an action, append one or more action lines AFTER your normal markdown answer.
Each action line MUST be on its own line and MUST start with the literal prefix "::action " followed by valid JSON.

Supported action types:
1) Navigate to a known destination — pick path_id ONLY from the AVAILABLE_NAVIGATION_TARGETS list:
   ::action {"type":"open_path","path_id":"<id>","label":"<short button text>"}

2) Open the app install/activate dialog for a specific app id:
   ::action {"type":"open_install_dialog","app_id":"<app id>","label":"Install <App>"}

Rules:
- NEVER invent a path_id. If the destination is not in AVAILABLE_NAVIGATION_TARGETS, do not emit an open_path action.
- Limit to at most 3 action blocks per reply.
- Always write the human-friendly explanation FIRST in markdown, then the action lines at the end.
- Do not wrap action lines in code fences.
`.trim();
