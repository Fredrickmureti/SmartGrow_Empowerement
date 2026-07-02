/**
 * Shared, ESM-pure JSON-schema + token extraction core for localization
 * pack payloads. The Deno edge function `validate-localization-payload`
 * imports it; vitest fixtures under `src/test/localization/*` import the
 * SAME module so the contract that the trigger / edge fn enforce in
 * production is exactly what the tests pin.
 *
 * Keep this file free of Deno-only globals (`Deno.*`), `npm:` specifiers
 * at module scope, and Supabase-client imports — the test runner
 * (Node + Vite) loads it directly.
 */

/**
 * Validate a payload against a (subset of) JSON Schema. Returns the list
 * of `<jsonpath>: <human message>` errors. An empty list means valid.
 */
export function validateAgainstSchema(payload: any, schema: any, path = "$"): string[] {
  const errs: string[] = [];
  if (!schema) return errs;
  const t = schema.type;
  if (payload === null || payload === undefined) {
    if (t && t !== "null" && !schema.nullable) errs.push(`${path}: value is null but schema requires ${t}`);
    return errs;
  }
  const jt = Array.isArray(payload) ? "array" : typeof payload;
  if (t) {
    if (t === "object" && jt !== "object") return [`${path}: expected object, got ${jt}`];
    if (t === "array" && jt !== "array") return [`${path}: expected array, got ${jt}`];
    if ((t === "number" || t === "integer") && jt !== "number") return [`${path}: expected ${t}, got ${jt}`];
    if (t === "string" && jt !== "string") return [`${path}: expected string, got ${jt}`];
    if (t === "boolean" && jt !== "boolean") return [`${path}: expected boolean, got ${jt}`];
  }
  if (schema.enum && !schema.enum.some((v: any) => JSON.stringify(v) === JSON.stringify(payload))) {
    errs.push(`${path}: value not in enum ${JSON.stringify(schema.enum)}`);
  }
  if (jt === "number") {
    if (schema.minimum !== undefined && payload < schema.minimum) errs.push(`${path}: below minimum ${schema.minimum}`);
    if (schema.maximum !== undefined && payload > schema.maximum) errs.push(`${path}: above maximum ${schema.maximum}`);
  }
  if (jt === "string") {
    if (schema.minLength !== undefined && payload.length < schema.minLength) errs.push(`${path}: shorter than minLength`);
    if (schema.maxLength !== undefined && payload.length > schema.maxLength) errs.push(`${path}: longer than maxLength`);
  }
  if (jt === "object") {
    for (const r of (schema.required ?? [])) {
      if (!(r in payload)) errs.push(`${path}.${r}: required property missing`);
    }
    for (const [k, sub] of Object.entries(schema.properties ?? {})) {
      if (k in payload) errs.push(...validateAgainstSchema(payload[k], sub, `${path}.${k}`));
    }
  }
  if (jt === "array" && schema.items) {
    payload.forEach((it: any, i: number) =>
      errs.push(...validateAgainstSchema(it, schema.items, `${path}[${i}]`)),
    );
  }
  return errs;
}

/**
 * Walk a template body and collect every `{{token.path}}` reference seen
 * in any nested string value. Used by the template-validation branch of
 * the edge function and by token-resolution fixtures.
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