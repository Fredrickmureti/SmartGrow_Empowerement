/**
 * Sandboxed payroll expression engine — Stage D.
 *
 * Tiny, hand-written tokenizer + Pratt parser + tree-walk evaluator. NO `eval`,
 * NO `new Function`, NO dynamic imports. Identifier whitelist is enforced at
 * evaluation time so an expression saved against today's whitelist cannot
 * silently expand if the runtime adds more globals later.
 *
 * Used by `compute-payroll/structureEngine.ts` (Deno) and re-exported through
 * `src/lib/payroll/expressionValidator.ts` for the SalaryStructures editor.
 *
 * Throws `RuleExpressionError` (code = "RULE_EXPRESSION_INVALID") with the
 * offending source offset on any caps breach, syntax error, unknown identifier,
 * or runtime error (division by zero, type mismatch).
 */

export const MAX_TOKENS = 200;
export const MAX_DEPTH = 32;
export const MAX_LENGTH = 2000;

export class RuleExpressionError extends Error {
  code = "RULE_EXPRESSION_INVALID" as const;
  constructor(message: string, public offset: number) {
    super(message);
  }
}

// ─── Symbol table shape (whitelist) ──────────────────────────────────────

export interface PayrollContext {
  BASIC: number;
  GROSS: number;
  TAXABLE: number;
  NET: number;
  employee: {
    country_code?: string;
    age?: number;
    gender?: string;
    marital_status?: string;
    dependants?: number;
  };
  contract: {
    wage?: number;
    hours_per_week?: number;
    structure_code?: string;
  };
  worked_hours: Record<string, number>;
  worked_days: Record<string, number>;
  result: Record<string, number>;
}

const SCALAR_KEYS = new Set(["BASIC", "GROSS", "TAXABLE", "NET"]);
const OBJECT_KEYS = new Set([
  "employee",
  "contract",
  "worked_hours",
  "worked_days",
  "result",
]);
const EMPLOYEE_FIELDS = new Set([
  "country_code",
  "age",
  "gender",
  "marital_status",
  "dependants",
]);
const CONTRACT_FIELDS = new Set(["wage", "hours_per_week", "structure_code"]);
const FUNCTIONS: Record<string, (args: unknown[]) => unknown> = {
  min: (a) => Math.min(...(a as number[])),
  max: (a) => Math.max(...(a as number[])),
  round: (a) => {
    const [x, n = 0] = a as [number, number?];
    const f = Math.pow(10, n);
    return Math.round((x as number) * f) / f;
  },
  if: (a) => ((a[0] as boolean | number) ? a[1] : a[2]),
};

// ─── Tokenizer ───────────────────────────────────────────────────────────

type TokenType =
  | "num" | "ident" | "str"
  | "(" | ")" | "[" | "]" | "," | "."
  | "+" | "-" | "*" | "/" | "%"
  | ">" | ">=" | "<" | "<=" | "==" | "!="
  | "&&" | "||" | "!" | "?" | ":";

interface Token { type: TokenType; value?: string | number; offset: number }

function tokenize(src: string): Token[] {
  if (src.length > MAX_LENGTH) {
    throw new RuleExpressionError(`expression exceeds ${MAX_LENGTH} chars`, 0);
  }
  const tokens: Token[] = [];
  let i = 0;
  while (i < src.length) {
    const c = src[i];
    if (c === " " || c === "\t" || c === "\n" || c === "\r") { i++; continue; }
    const start = i;
    if (c >= "0" && c <= "9") {
      let j = i;
      while (j < src.length && /[0-9.]/.test(src[j])) j++;
      tokens.push({ type: "num", value: parseFloat(src.slice(i, j)), offset: start });
      i = j; continue;
    }
    if (c === "'" || c === '"') {
      const quote = c;
      let j = i + 1;
      while (j < src.length && src[j] !== quote) j++;
      if (j >= src.length) throw new RuleExpressionError("unterminated string", start);
      tokens.push({ type: "str", value: src.slice(i + 1, j), offset: start });
      i = j + 1; continue;
    }
    if (/[A-Za-z_]/.test(c)) {
      let j = i;
      while (j < src.length && /[A-Za-z0-9_]/.test(src[j])) j++;
      tokens.push({ type: "ident", value: src.slice(i, j), offset: start });
      i = j; continue;
    }
    const two = src.slice(i, i + 2);
    if (["==", "!=", ">=", "<=", "&&", "||"].includes(two)) {
      tokens.push({ type: two as TokenType, offset: start });
      i += 2; continue;
    }
    if ("()[],.+-*/%<>?:!".includes(c)) {
      tokens.push({ type: c as TokenType, offset: start });
      i++; continue;
    }
    throw new RuleExpressionError(`unexpected character '${c}'`, start);
  }
  if (tokens.length > MAX_TOKENS) {
    throw new RuleExpressionError(`expression exceeds ${MAX_TOKENS} tokens`, 0);
  }
  return tokens;
}

// ─── Parser (Pratt) ──────────────────────────────────────────────────────

type Node =
  | { kind: "num"; value: number; offset: number }
  | { kind: "str"; value: string; offset: number }
  | { kind: "ident"; name: string; offset: number }
  | { kind: "member"; obj: Node; field: string; offset: number }
  | { kind: "index"; obj: Node; key: Node; offset: number }
  | { kind: "call"; name: string; args: Node[]; offset: number }
  | { kind: "unary"; op: "-" | "!"; arg: Node; offset: number }
  | { kind: "bin"; op: string; left: Node; right: Node; offset: number }
  | { kind: "ternary"; cond: Node; then: Node; else: Node; offset: number };

const PRECEDENCE: Record<string, number> = {
  "||": 1, "&&": 2,
  "==": 3, "!=": 3,
  "<": 4, "<=": 4, ">": 4, ">=": 4,
  "+": 5, "-": 5,
  "*": 6, "/": 6, "%": 6,
};

class Parser {
  pos = 0;
  depth = 0;
  constructor(public tokens: Token[]) {}

  peek(): Token | undefined { return this.tokens[this.pos]; }
  eat(type?: TokenType): Token {
    const t = this.tokens[this.pos];
    if (!t) throw new RuleExpressionError("unexpected end of expression", this.tokens[this.pos - 1]?.offset ?? 0);
    if (type && t.type !== type) throw new RuleExpressionError(`expected '${type}', got '${t.type}'`, t.offset);
    this.pos++;
    return t;
  }
  enter(off: number) {
    if (++this.depth > MAX_DEPTH) throw new RuleExpressionError(`expression nesting exceeds ${MAX_DEPTH}`, off);
  }
  leave() { this.depth--; }

  parse(): Node {
    const node = this.parseTernary();
    if (this.pos !== this.tokens.length) {
      throw new RuleExpressionError(`unexpected token '${this.tokens[this.pos].type}'`, this.tokens[this.pos].offset);
    }
    return node;
  }

  parseTernary(): Node {
    const cond = this.parseBinary(0);
    if (this.peek()?.type === "?") {
      const off = this.eat("?").offset;
      this.enter(off);
      const then = this.parseTernary();
      this.eat(":");
      const els = this.parseTernary();
      this.leave();
      return { kind: "ternary", cond, then, else: els, offset: off };
    }
    return cond;
  }

  parseBinary(minPrec: number): Node {
    let left = this.parseUnary();
    while (true) {
      const t = this.peek();
      if (!t) break;
      const prec = PRECEDENCE[t.type];
      if (prec === undefined || prec < minPrec) break;
      this.eat();
      this.enter(t.offset);
      const right = this.parseBinary(prec + 1);
      this.leave();
      left = { kind: "bin", op: t.type, left, right, offset: t.offset };
    }
    return left;
  }

  parseUnary(): Node {
    const t = this.peek();
    if (t?.type === "-" || t?.type === "!") {
      this.eat();
      this.enter(t.offset);
      const arg = this.parseUnary();
      this.leave();
      return { kind: "unary", op: t.type as "-" | "!", arg, offset: t.offset };
    }
    return this.parsePostfix();
  }

  parsePostfix(): Node {
    let node = this.parsePrimary();
    while (true) {
      const t = this.peek();
      if (t?.type === ".") {
        this.eat();
        const name = this.eat("ident");
        node = { kind: "member", obj: node, field: name.value as string, offset: t.offset };
      } else if (t?.type === "[") {
        this.eat();
        this.enter(t.offset);
        const key = this.parseTernary();
        this.eat("]");
        this.leave();
        node = { kind: "index", obj: node, key, offset: t.offset };
      } else break;
    }
    return node;
  }

  parsePrimary(): Node {
    const t = this.eat();
    if (t.type === "num") return { kind: "num", value: t.value as number, offset: t.offset };
    if (t.type === "str") return { kind: "str", value: t.value as string, offset: t.offset };
    if (t.type === "(") {
      this.enter(t.offset);
      const n = this.parseTernary();
      this.eat(")");
      this.leave();
      return n;
    }
    if (t.type === "ident") {
      const name = t.value as string;
      if (this.peek()?.type === "(") {
        this.eat();
        const args: Node[] = [];
        if (this.peek()?.type !== ")") {
          args.push(this.parseTernary());
          while (this.peek()?.type === ",") { this.eat(); args.push(this.parseTernary()); }
        }
        this.eat(")");
        return { kind: "call", name, args, offset: t.offset };
      }
      return { kind: "ident", name, offset: t.offset };
    }
    throw new RuleExpressionError(`unexpected token '${t.type}'`, t.offset);
  }
}

// ─── Evaluator ───────────────────────────────────────────────────────────

function evalNode(node: Node, ctx: PayrollContext): unknown {
  switch (node.kind) {
    case "num": return node.value;
    case "str": return node.value;
    case "ident": {
      if (SCALAR_KEYS.has(node.name)) return (ctx as any)[node.name] ?? 0;
      if (OBJECT_KEYS.has(node.name)) return (ctx as any)[node.name];
      throw new RuleExpressionError(`unknown identifier '${node.name}'`, node.offset);
    }
    case "member": {
      const obj = evalNode(node.obj, ctx) as any;
      // Whitelist fields per known parent
      const parent = node.obj.kind === "ident" ? node.obj.name : null;
      if (parent === "employee" && !EMPLOYEE_FIELDS.has(node.field)) {
        throw new RuleExpressionError(`unknown field employee.${node.field}`, node.offset);
      }
      if (parent === "contract" && !CONTRACT_FIELDS.has(node.field)) {
        throw new RuleExpressionError(`unknown field contract.${node.field}`, node.offset);
      }
      if (obj == null) return 0;
      return obj[node.field];
    }
    case "index": {
      const obj = evalNode(node.obj, ctx) as any;
      const key = evalNode(node.key, ctx) as string | number;
      if (obj == null) return 0;
      return obj[key as any] ?? 0;
    }
    case "call": {
      const fn = FUNCTIONS[node.name];
      if (!fn) throw new RuleExpressionError(`unknown function '${node.name}'`, node.offset);
      const args = node.args.map((a) => evalNode(a, ctx));
      return fn(args);
    }
    case "unary": {
      const v = evalNode(node.arg, ctx);
      return node.op === "-" ? -(v as number) : !v;
    }
    case "ternary":
      return evalNode(node.cond, ctx) ? evalNode(node.then, ctx) : evalNode(node.else, ctx);
    case "bin": {
      const l = evalNode(node.left, ctx) as any;
      const r = evalNode(node.right, ctx) as any;
      switch (node.op) {
        case "+": return (l ?? 0) + (r ?? 0);
        case "-": return (l ?? 0) - (r ?? 0);
        case "*": return (l ?? 0) * (r ?? 0);
        case "/":
          if (r === 0) throw new RuleExpressionError("division by zero", node.offset);
          return l / r;
        case "%":
          if (r === 0) throw new RuleExpressionError("modulo by zero", node.offset);
          return l % r;
        case ">": return l > r;
        case ">=": return l >= r;
        case "<": return l < r;
        case "<=": return l <= r;
        case "==": return l === r;
        case "!=": return l !== r;
        case "&&": return l && r;
        case "||": return l || r;
      }
    }
  }
  throw new RuleExpressionError("internal evaluator error", 0);
}

// ─── Public API ──────────────────────────────────────────────────────────

export function parseExpression(src: string): Node {
  return new Parser(tokenize(src)).parse();
}

export function evaluateExpression(src: string, ctx: PayrollContext): unknown {
  return evalNode(parseExpression(src), ctx);
}

/** Validate without evaluating. Returns null if OK, error otherwise. */
export function validateExpression(src: string): { ok: true } | { ok: false; message: string; offset: number } {
  try {
    parseExpression(src);
    return { ok: true };
  } catch (e) {
    if (e instanceof RuleExpressionError) return { ok: false, message: e.message, offset: e.offset };
    return { ok: false, message: (e as Error).message, offset: 0 };
  }
}

/**
 * Phase 3 — Dependency extraction for topological sort / cycle detection.
 *
 * Walks the parsed AST and returns the set of TOP-LEVEL identifiers
 * referenced. This is what structure-graph rules can legitimately depend
 * on for ordering purposes:
 *
 *   - `BASIC`, `GROSS`, `TAXABLE`, `NET`  → running totals (built-in)
 *   - `result.<code>` or `result["<code>"]` → sibling salary-rule code
 *   - bare rule codes referenced directly (e.g. `HRA * 0.5`)
 *
 * Function calls (round, min, if, etc.) are traversed for their args but
 * the function name itself is NOT returned. `employee.*`, `contract.*`,
 * and `worked_hours.*` member accesses are traversed but the root
 * identifier is returned untouched so callers can filter them out.
 *
 * Returns identifier NAMES, not offsets — callers do their own graph
 * math. Malformed expressions raise `RuleExpressionError` unchanged.
 */
export function extractIdentifiers(src: string): string[] {
  const seen = new Set<string>();
  const walk = (n: Node): void => {
    switch (n.kind) {
      case "num":
      case "str":
        return;
      case "ident":
        seen.add(n.name);
        return;
      case "member":
        // `result.<code>` is the canonical sibling-reference form. Surface
        // the leaf code so the graph builder can wire the dependency.
        if (n.obj.kind === "ident" && n.obj.name === "result") {
          seen.add(n.field);
          return;
        }
        walk(n.obj);
        return;
      case "index":
        if (n.obj.kind === "ident" && n.obj.name === "result" && n.key.kind === "str") {
          seen.add(n.key.value);
          return;
        }
        walk(n.obj);
        walk(n.key);
        return;
      case "call":
        for (const a of n.args) walk(a);
        return;
      case "unary":
        walk(n.arg);
        return;
      case "bin":
        walk(n.left);
        walk(n.right);
        return;
      case "ternary":
        walk(n.cond);
        walk(n.then);
        walk(n.else);
        return;
    }
  };
  walk(parseExpression(src));
  return [...seen];
}

