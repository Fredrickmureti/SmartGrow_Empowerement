/**
 * Advanced Condition Evaluator for Automation Rules
 * Supports complex nested conditions with AND/OR logic, comparison operators,
 * and field-based evaluations similar to Odoo's domain system.
 */

export type ComparisonOperator =
  | "="
  | "!="
  | ">"
  | "<"
  | ">="
  | "<="
  | "in"
  | "not_in"
  | "contains"
  | "not_contains"
  | "starts_with"
  | "ends_with"
  | "is_set"
  | "is_not_set"
  | "changed"
  | "changed_to"
  | "changed_from";

export type LogicalOperator = "and" | "or";

export interface SimpleCondition {
  field: string;
  operator: ComparisonOperator;
  value?: unknown;
}

export interface ConditionGroup {
  logic: LogicalOperator;
  conditions: Array<SimpleCondition | ConditionGroup>;
}

export type Condition = SimpleCondition | ConditionGroup;

export interface EvaluationContext {
  record: Record<string, unknown>;
  oldRecord?: Record<string, unknown>;
  changedFields?: string[];
  user?: { id: string; email?: string; role?: string };
  now?: Date;
}

/**
 * Resolves nested field paths like "contact.email" or "items[0].price"
 */
function getFieldValue(obj: Record<string, unknown>, path: string): unknown {
  const parts = path.split(".");
  let current: unknown = obj;

  for (const part of parts) {
    if (current === null || current === undefined) return undefined;

    // Handle array indexing like "items[0]"
    const arrayMatch = part.match(/^(\w+)\[(\d+)\]$/);
    if (arrayMatch) {
      const [, arrayName, indexStr] = arrayMatch;
      const index = parseInt(indexStr, 10);
      current = (current as Record<string, unknown>)[arrayName];
      if (Array.isArray(current)) {
        current = current[index];
      } else {
        return undefined;
      }
    } else {
      current = (current as Record<string, unknown>)[part];
    }
  }

  return current;
}

/**
 * Compares two values for equality with type coercion
 */
function isEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (a === null || a === undefined) return b === null || b === undefined;
  
  // Handle date comparison
  if (a instanceof Date && b instanceof Date) {
    return a.getTime() === b.getTime();
  }
  
  // String date comparison
  if (typeof a === "string" && typeof b === "string") {
    const dateA = Date.parse(a);
    const dateB = Date.parse(b);
    if (!isNaN(dateA) && !isNaN(dateB)) {
      return dateA === dateB;
    }
  }
  
  // Number/string coercion
  if (typeof a === "number" && typeof b === "string") {
    return a === parseFloat(b);
  }
  if (typeof a === "string" && typeof b === "number") {
    return parseFloat(a) === b;
  }
  
  return String(a).toLowerCase() === String(b).toLowerCase();
}

/**
 * Compares two values numerically
 */
function compareNumeric(a: unknown, b: unknown): number {
  const numA = typeof a === "number" ? a : parseFloat(String(a));
  const numB = typeof b === "number" ? b : parseFloat(String(b));
  
  if (isNaN(numA) || isNaN(numB)) {
    return String(a).localeCompare(String(b));
  }
  
  return numA - numB;
}

/**
 * Evaluates a single condition against the context
 */
function evaluateSimpleCondition(
  condition: SimpleCondition,
  context: EvaluationContext
): boolean {
  const { field, operator, value } = condition;
  const fieldValue = getFieldValue(context.record, field);
  const oldFieldValue = context.oldRecord
    ? getFieldValue(context.oldRecord, field)
    : undefined;

  switch (operator) {
    case "=":
      return isEqual(fieldValue, value);

    case "!=":
      return !isEqual(fieldValue, value);

    case ">":
      return compareNumeric(fieldValue, value) > 0;

    case "<":
      return compareNumeric(fieldValue, value) < 0;

    case ">=":
      return compareNumeric(fieldValue, value) >= 0;

    case "<=":
      return compareNumeric(fieldValue, value) <= 0;

    case "in":
      if (!Array.isArray(value)) return false;
      return value.some((v) => isEqual(fieldValue, v));

    case "not_in":
      if (!Array.isArray(value)) return true;
      return !value.some((v) => isEqual(fieldValue, v));

    case "contains":
      if (typeof fieldValue !== "string") return false;
      return fieldValue.toLowerCase().includes(String(value).toLowerCase());

    case "not_contains":
      if (typeof fieldValue !== "string") return true;
      return !fieldValue.toLowerCase().includes(String(value).toLowerCase());

    case "starts_with":
      if (typeof fieldValue !== "string") return false;
      return fieldValue.toLowerCase().startsWith(String(value).toLowerCase());

    case "ends_with":
      if (typeof fieldValue !== "string") return false;
      return fieldValue.toLowerCase().endsWith(String(value).toLowerCase());

    case "is_set":
      return (
        fieldValue !== null &&
        fieldValue !== undefined &&
        fieldValue !== ""
      );

    case "is_not_set":
      return (
        fieldValue === null ||
        fieldValue === undefined ||
        fieldValue === ""
      );

    case "changed":
      return (
        context.changedFields?.includes(field) ||
        !isEqual(fieldValue, oldFieldValue)
      );

    case "changed_to":
      const didChange =
        context.changedFields?.includes(field) ||
        !isEqual(fieldValue, oldFieldValue);
      return didChange && isEqual(fieldValue, value);

    case "changed_from":
      const wasChanged =
        context.changedFields?.includes(field) ||
        !isEqual(fieldValue, oldFieldValue);
      return wasChanged && isEqual(oldFieldValue, value);

    default:
      console.warn(`Unknown operator: ${operator}`);
      return false;
  }
}

/**
 * Checks if a condition is a group (has nested conditions)
 */
function isConditionGroup(condition: Condition): condition is ConditionGroup {
  return "logic" in condition && "conditions" in condition;
}

/**
 * Recursively evaluates a condition or condition group
 */
export function evaluateCondition(
  condition: Condition | null | undefined,
  context: EvaluationContext
): boolean {
  if (!condition) return true; // No condition = always pass

  if (isConditionGroup(condition)) {
    const { logic, conditions } = condition;

    if (conditions.length === 0) return true;

    if (logic === "and") {
      return conditions.every((c) => evaluateCondition(c, context));
    } else {
      return conditions.some((c) => evaluateCondition(c, context));
    }
  }

  return evaluateSimpleCondition(condition, context);
}

/**
 * Evaluates an array of conditions with AND logic (legacy format)
 */
export function evaluateConditionArray(
  conditions: Array<SimpleCondition> | null | undefined,
  context: EvaluationContext
): boolean {
  if (!conditions || conditions.length === 0) return true;
  return conditions.every((c) => evaluateSimpleCondition(c, context));
}

/**
 * Parses domain-style conditions (Odoo format)
 * Format: [["field", "operator", "value"], ...]
 */
export function parseDomainConditions(
  domain: Array<[string, string, unknown]> | null | undefined
): SimpleCondition[] {
  if (!domain || !Array.isArray(domain)) return [];

  return domain.map(([field, operator, value]) => ({
    field,
    operator: operator as ComparisonOperator,
    value,
  }));
}

/**
 * Validates a condition structure
 */
export function validateCondition(condition: unknown): condition is Condition {
  if (!condition || typeof condition !== "object") return false;

  if ("logic" in condition && "conditions" in condition) {
    const group = condition as ConditionGroup;
    if (!["and", "or"].includes(group.logic)) return false;
    if (!Array.isArray(group.conditions)) return false;
    return group.conditions.every(validateCondition);
  }

  if ("field" in condition && "operator" in condition) {
    const simple = condition as SimpleCondition;
    return typeof simple.field === "string" && typeof simple.operator === "string";
  }

  return false;
}

/**
 * Creates a condition builder for fluent API
 */
export class ConditionBuilder {
  private conditions: Array<SimpleCondition | ConditionGroup> = [];
  private logic: LogicalOperator = "and";

  constructor(logic: LogicalOperator = "and") {
    this.logic = logic;
  }

  static and(): ConditionBuilder {
    return new ConditionBuilder("and");
  }

  static or(): ConditionBuilder {
    return new ConditionBuilder("or");
  }

  where(field: string, operator: ComparisonOperator, value?: unknown): this {
    this.conditions.push({ field, operator, value });
    return this;
  }

  equals(field: string, value: unknown): this {
    return this.where(field, "=", value);
  }

  notEquals(field: string, value: unknown): this {
    return this.where(field, "!=", value);
  }

  greaterThan(field: string, value: number): this {
    return this.where(field, ">", value);
  }

  lessThan(field: string, value: number): this {
    return this.where(field, "<", value);
  }

  contains(field: string, value: string): this {
    return this.where(field, "contains", value);
  }

  isSet(field: string): this {
    return this.where(field, "is_set");
  }

  isNotSet(field: string): this {
    return this.where(field, "is_not_set");
  }

  changed(field: string): this {
    return this.where(field, "changed");
  }

  changedTo(field: string, value: unknown): this {
    return this.where(field, "changed_to", value);
  }

  group(builder: ConditionBuilder): this {
    this.conditions.push(builder.build());
    return this;
  }

  build(): ConditionGroup {
    return {
      logic: this.logic,
      conditions: this.conditions,
    };
  }
}
