/**
 * Client-safe re-export of the shared token-extractor used by the
 * `validate-localization-payload` edge function. Keeping a thin wrapper
 * avoids browser bundlers reaching into Deno-only siblings of that file.
 */
export function extractTokens(node: any, out: Set<string> = new Set()): Set<string> {
  if (typeof node === "string") {
    const re = /\{\{\s*([a-zA-Z0-9_.]+)\s*\}\}/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(node)) !== null) out.add(m[1]);
  } else if (Array.isArray(node)) {
    node.forEach((n) => extractTokens(n, out));
  } else if (node && typeof node === "object") {
    Object.values(node).forEach((v) => extractTokens(v, out));
  }
  return out;
}
