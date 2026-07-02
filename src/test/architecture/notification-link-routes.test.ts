/**
 * Architecture guard: every literal `link` argument we pass to
 * `create_notification(...)` from a SQL migration must resolve to a route
 * that actually exists in the React app.
 *
 * This catches the class of bug where an inventory notification was emitted
 * with `link = '/inventory'` even though the inventory module was moved
 * under `/inventory-app/*`, sending users to a 404 on every click.
 *
 * Approach: parse every migration for `create_notification(...)` calls,
 * extract the 7th positional argument (the `p_link` literal), and assert
 * that it matches one of the route prefixes registered in App.tsx + the
 * app routers under src/apps/.
 */
import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

const REPO_ROOT = process.cwd();
const MIGRATIONS_DIR = join(REPO_ROOT, "supabase", "migrations");

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    const st = statSync(p);
    if (st.isDirectory()) walk(p, out);
    else if (/\.(tsx?|sql)$/.test(name)) out.push(p);
  }
  return out;
}

/** Collect every route path literal registered in the SPA. */
function collectAppRoutes(): string[] {
  const files = walk(join(REPO_ROOT, "src"))
    .filter((f) => /(App\.tsx|apps\/.+routes\.tsx?)$/.test(f));
  const paths = new Set<string>(["/"]);
  // Mount roots so we accept anything under `/inventory-app/*` etc.
  const re = /path\s*=\s*["'`]([^"'`]+)["'`]/g;
  for (const f of files) {
    const src = readFileSync(f, "utf8");
    let m: RegExpExecArray | null;
    while ((m = re.exec(src)) !== null) {
      let p = m[1];
      if (!p.startsWith("/")) p = "/" + p;
      // Strip wildcard/params for prefix matching.
      p = p.replace(/\/\*$/, "").replace(/\/:[^/]+/g, "");
      if (p === "") p = "/";
      paths.add(p);
    }
  }
  return [...paths];
}

/**
 * Find every `create_notification(...)` call in SQL and pull the 7th arg
 * (`p_link`). We expect arguments in the canonical positional order used
 * across the codebase:
 *   create_notification(org, user, type, category, title, message, link, ...)
 */
function collectNotificationLinks(): { file: string; link: string }[] {
  // Migrations are timestamp-prefixed, so lexical sort = chronological.
  // Keep ONLY the latest body per function name; older `CREATE OR REPLACE`
  // definitions are superseded and must not produce false positives.
  const files = walk(MIGRATIONS_DIR).filter((f) => f.endsWith(".sql")).sort();
  const latestByFn = new Map<string, { file: string; body: string }>();
  const fnRe =
    /CREATE\s+OR\s+REPLACE\s+FUNCTION\s+public\.([a-zA-Z0-9_]+)\s*\([\s\S]*?(?:\$function\$|\$\$)\s*;/gi;
  for (const f of files) {
    const sql = readFileSync(f, "utf8");
    let m: RegExpExecArray | null;
    while ((m = fnRe.exec(sql)) !== null) {
      latestByFn.set(m[1], { file: f, body: m[0] });
    }
  }

  const links: { file: string; link: string }[] = [];
  const callRe = /create_notification\s*\(([\s\S]*?)\)\s*;?/gi;
  for (const { file, body } of latestByFn.values()) {
    let m: RegExpExecArray | null;
    while ((m = callRe.exec(body)) !== null) {
      const args = splitTopLevel(m[1]);
      if (args.length < 7) continue;
      const raw = args[6].trim();
      const lit = raw.match(/^'([^']*)'(?:::[a-zA-Z_ ]+)?$/);
      if (!lit) continue;
      const link = lit[1];
      if (!link.startsWith("/")) continue;
      links.push({ file: file.replace(REPO_ROOT + "/", ""), link });
    }
  }
  return links;
}

/** Split a comma list at top-level parens/brackets only. */
function splitTopLevel(s: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let buf = "";
  let inStr = false;
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (inStr) {
      buf += ch;
      if (ch === "'" && s[i + 1] !== "'") inStr = false;
      continue;
    }
    if (ch === "'") {
      inStr = true;
      buf += ch;
      continue;
    }
    if (ch === "(" || ch === "[") depth++;
    else if (ch === ")" || ch === "]") depth--;
    if (ch === "," && depth === 0) {
      out.push(buf);
      buf = "";
    } else {
      buf += ch;
    }
  }
  if (buf.trim().length) out.push(buf);
  return out;
}

describe("notification link routes", () => {
  const routes = collectAppRoutes();
  const links = collectNotificationLinks();

  it("collects at least one create_notification call from migrations", () => {
    expect(links.length).toBeGreaterThan(0);
  });

  it("every literal notification link resolves to a registered SPA route", () => {
    const offenders: string[] = [];
    for (const { file, link } of links) {
      const ok = routes.some((r) => {
        if (r === "/") return link === "/";
        return link === r || link.startsWith(r + "/");
      });
      if (!ok) offenders.push(`${file} → link="${link}"`);
    }
    if (offenders.length) {
      // Surface a precise diagnostic so future drifts are easy to fix.
      throw new Error(
        "Notification links point at routes that do not exist in the SPA " +
          "(users will hit /404 when they click the notification):\n" +
          offenders.map((s) => "  - " + s).join("\n"),
      );
    }
  });
});
