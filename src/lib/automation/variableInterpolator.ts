/**
 * Variable Interpolation Engine for Automation Templates
 * Supports Mustache-style {{variable}} syntax with nested paths,
 * filters, and fallback values.
 */

import { format, formatDistance, parseISO } from "date-fns";

export interface InterpolationContext {
  record?: Record<string, unknown>;
  oldRecord?: Record<string, unknown>;
  user?: { id: string; email?: string; name?: string };
  organization?: { id: string; name?: string };
  now?: Date;
  custom?: Record<string, unknown>;
}

type FilterFunction = (value: unknown, ...args: string[]) => string;

// Built-in filters for transforming values
const BUILT_IN_FILTERS: Record<string, FilterFunction> = {
  // String filters
  upper: (v) => String(v).toUpperCase(),
  lower: (v) => String(v).toLowerCase(),
  capitalize: (v) => {
    const str = String(v);
    return str.charAt(0).toUpperCase() + str.slice(1).toLowerCase();
  },
  title: (v) =>
    String(v)
      .split(" ")
      .map((w) => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase())
      .join(" "),
  trim: (v) => String(v).trim(),
  truncate: (v, length = "50") => {
    const str = String(v);
    const len = parseInt(length, 10);
    return str.length > len ? str.slice(0, len) + "..." : str;
  },
  replace: (v, search = "", replacement = "") =>
    String(v).replace(new RegExp(search, "g"), replacement),
  default: (v, defaultValue = "") =>
    v === null || v === undefined || v === "" ? defaultValue : String(v),

  // Number filters
  currency: (v, currencyCode = "USD") => {
    const num = typeof v === "number" ? v : parseFloat(String(v));
    if (isNaN(num)) return String(v);
    return new Intl.NumberFormat("en-US", {
      style: "currency",
      currency: currencyCode,
    }).format(num);
  },
  number: (v, decimals = "2") => {
    const num = typeof v === "number" ? v : parseFloat(String(v));
    if (isNaN(num)) return String(v);
    return num.toLocaleString(undefined, {
      minimumFractionDigits: parseInt(decimals, 10),
      maximumFractionDigits: parseInt(decimals, 10),
    });
  },
  percent: (v, decimals = "0") => {
    const num = typeof v === "number" ? v : parseFloat(String(v));
    if (isNaN(num)) return String(v);
    return (num * 100).toFixed(parseInt(decimals, 10)) + "%";
  },
  round: (v, decimals = "0") => {
    const num = typeof v === "number" ? v : parseFloat(String(v));
    if (isNaN(num)) return String(v);
    return num.toFixed(parseInt(decimals, 10));
  },

  // Date filters
  date: (v, formatStr = "PP") => {
    try {
      const date = v instanceof Date ? v : parseISO(String(v));
      return format(date, formatStr);
    } catch {
      return String(v);
    }
  },
  datetime: (v) => {
    try {
      const date = v instanceof Date ? v : parseISO(String(v));
      return format(date, "PPpp");
    } catch {
      return String(v);
    }
  },
  relative: (v) => {
    try {
      const date = v instanceof Date ? v : parseISO(String(v));
      return formatDistance(date, new Date(), { addSuffix: true });
    } catch {
      return String(v);
    }
  },
  iso: (v) => {
    try {
      const date = v instanceof Date ? v : parseISO(String(v));
      return date.toISOString();
    } catch {
      return String(v);
    }
  },

  // Array filters
  join: (v, separator = ", ") => {
    if (Array.isArray(v)) return v.join(separator);
    return String(v);
  },
  first: (v) => {
    if (Array.isArray(v)) return String(v[0] ?? "");
    return String(v);
  },
  last: (v) => {
    if (Array.isArray(v)) return String(v[v.length - 1] ?? "");
    return String(v);
  },
  count: (v) => {
    if (Array.isArray(v)) return String(v.length);
    if (typeof v === "string") return String(v.length);
    return "0";
  },

  // Conditional filters
  yesno: (v, yesVal = "Yes", noVal = "No") =>
    v && v !== "false" && v !== "0" ? yesVal : noVal,
  pluralize: (v, singular = "", plural = "s") => {
    const num = typeof v === "number" ? v : parseInt(String(v), 10);
    return num === 1 ? singular : plural;
  },

  // JSON filters
  json: (v) => {
    try {
      return JSON.stringify(v, null, 2);
    } catch {
      return String(v);
    }
  },
  jsoncompact: (v) => {
    try {
      return JSON.stringify(v);
    } catch {
      return String(v);
    }
  },
};

/**
 * Resolves a nested path from an object
 * Supports dot notation: "contact.email"
 * And array indexing: "items[0].name"
 */
function resolvePath(obj: Record<string, unknown>, path: string): unknown {
  const parts = path.split(".");
  let current: unknown = obj;

  for (const part of parts) {
    if (current === null || current === undefined) return undefined;

    // Handle array indexing
    const arrayMatch = part.match(/^(\w+)\[(\d+)\]$/);
    if (arrayMatch) {
      const [, arrayName, indexStr] = arrayMatch;
      current = (current as Record<string, unknown>)[arrayName];
      if (Array.isArray(current)) {
        current = current[parseInt(indexStr, 10)];
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
 * Resolves a variable reference from context
 * Supports special prefixes:
 * - record.field - Current record data
 * - old.field - Previous record data (for updates)
 * - user.field - Current user data
 * - org.field - Organization data
 * - now - Current datetime
 * - env.KEY - Environment variable (server-side only)
 */
function resolveVariable(
  variable: string,
  context: InterpolationContext
): unknown {
  const trimmed = variable.trim();

  // Special variables
  if (trimmed === "now") {
    return context.now || new Date();
  }

  // Prefixed paths
  if (trimmed.startsWith("record.")) {
    return resolvePath(context.record || {}, trimmed.slice(7));
  }
  if (trimmed.startsWith("old.")) {
    return resolvePath(context.oldRecord || {}, trimmed.slice(4));
  }
  if (trimmed.startsWith("user.")) {
    return resolvePath((context.user as Record<string, unknown>) || {}, trimmed.slice(5));
  }
  if (trimmed.startsWith("org.")) {
    return resolvePath((context.organization as Record<string, unknown>) || {}, trimmed.slice(4));
  }
  if (trimmed.startsWith("custom.")) {
    return resolvePath(context.custom || {}, trimmed.slice(7));
  }

  // Try direct record access (shorthand)
  if (context.record && trimmed in context.record) {
    return context.record[trimmed];
  }

  // Try nested record access
  return resolvePath(context.record || {}, trimmed);
}

/**
 * Parses a filter chain from variable expression
 * Format: variable|filter1|filter2:arg1:arg2
 */
function parseFilters(
  expression: string
): { variable: string; filters: Array<{ name: string; args: string[] }> } {
  const parts = expression.split("|");
  const variable = parts[0].trim();
  const filters: Array<{ name: string; args: string[] }> = [];

  for (let i = 1; i < parts.length; i++) {
    const filterParts = parts[i].split(":");
    const name = filterParts[0].trim();
    const args = filterParts.slice(1).map((a) => a.trim());
    filters.push({ name, args });
  }

  return { variable, filters };
}

/**
 * Applies filters to a value
 */
function applyFilters(
  value: unknown,
  filters: Array<{ name: string; args: string[] }>
): string {
  let result = value;

  for (const filter of filters) {
    const filterFn = BUILT_IN_FILTERS[filter.name];
    if (filterFn) {
      result = filterFn(result, ...filter.args);
    } else {
      console.warn(`Unknown filter: ${filter.name}`);
    }
  }

  return result === null || result === undefined ? "" : String(result);
}

/**
 * Interpolates variables in a template string
 * Syntax: {{variable}} or {{variable|filter1|filter2:arg}}
 * 
 * Also supports conditional blocks:
 * {{#if condition}}content{{/if}}
 * {{#unless condition}}content{{/unless}}
 * {{#each items}}{{this.name}}{{/each}}
 */
export function interpolate(
  template: string,
  context: InterpolationContext
): string {
  if (!template) return "";

  // Process simple variable substitution
  let result = template.replace(
    /\{\{([^{}]+)\}\}/g,
    (match, expression) => {
      const { variable, filters } = parseFilters(expression);
      const value = resolveVariable(variable, context);
      return applyFilters(value, filters);
    }
  );

  // Process {{#if condition}}...{{/if}} blocks
  result = result.replace(
    /\{\{#if\s+([^}]+)\}\}([\s\S]*?)\{\{\/if\}\}/g,
    (match, condition, content) => {
      const value = resolveVariable(condition.trim(), context);
      const isTruthy = value && value !== "false" && value !== "0" && value !== "null";
      return isTruthy ? interpolate(content, context) : "";
    }
  );

  // Process {{#unless condition}}...{{/unless}} blocks
  result = result.replace(
    /\{\{#unless\s+([^}]+)\}\}([\s\S]*?)\{\{\/unless\}\}/g,
    (match, condition, content) => {
      const value = resolveVariable(condition.trim(), context);
      const isTruthy = value && value !== "false" && value !== "0" && value !== "null";
      return !isTruthy ? interpolate(content, context) : "";
    }
  );

  // Process {{#each items}}...{{/each}} blocks
  result = result.replace(
    /\{\{#each\s+([^}]+)\}\}([\s\S]*?)\{\{\/each\}\}/g,
    (match, arrayPath, content) => {
      const array = resolveVariable(arrayPath.trim(), context);
      if (!Array.isArray(array)) return "";
      
      return array
        .map((item, index) => {
          const itemContext: InterpolationContext = {
            ...context,
            custom: {
              ...context.custom,
              this: item,
              index,
              first: index === 0,
              last: index === array.length - 1,
            },
          };
          return interpolate(content, itemContext);
        })
        .join("");
    }
  );

  return result;
}

/**
 * Interpolates variables in an object (recursively)
 */
export function interpolateObject<T extends Record<string, unknown>>(
  obj: T,
  context: InterpolationContext
): T {
  const result: Record<string, unknown> = {};

  for (const [key, value] of Object.entries(obj)) {
    if (typeof value === "string") {
      result[key] = interpolate(value, context);
    } else if (Array.isArray(value)) {
      result[key] = value.map((item) =>
        typeof item === "object" && item !== null
          ? interpolateObject(item as Record<string, unknown>, context)
          : typeof item === "string"
          ? interpolate(item, context)
          : item
      );
    } else if (typeof value === "object" && value !== null) {
      result[key] = interpolateObject(value as Record<string, unknown>, context);
    } else {
      result[key] = value;
    }
  }

  return result as T;
}

/**
 * Extracts all variable references from a template
 */
export function extractVariables(template: string): string[] {
  const variables: Set<string> = new Set();
  const regex = /\{\{([^{}|]+)/g;
  let match;

  while ((match = regex.exec(template)) !== null) {
    const variable = match[1].trim();
    if (!variable.startsWith("#") && !variable.startsWith("/")) {
      variables.add(variable);
    }
  }

  return Array.from(variables);
}

/**
 * Validates a template for syntax errors
 */
export function validateTemplate(template: string): {
  valid: boolean;
  errors: string[];
} {
  const errors: string[] = [];

  // Check for unclosed tags
  const openBraces = (template.match(/\{\{/g) || []).length;
  const closeBraces = (template.match(/\}\}/g) || []).length;
  if (openBraces !== closeBraces) {
    errors.push(`Mismatched braces: ${openBraces} open, ${closeBraces} close`);
  }

  // Check for unclosed blocks
  const ifBlocks = (template.match(/\{\{#if/g) || []).length;
  const endIfBlocks = (template.match(/\{\{\/if\}\}/g) || []).length;
  if (ifBlocks !== endIfBlocks) {
    errors.push(`Unclosed #if blocks: ${ifBlocks} open, ${endIfBlocks} closed`);
  }

  const eachBlocks = (template.match(/\{\{#each/g) || []).length;
  const endEachBlocks = (template.match(/\{\{\/each\}\}/g) || []).length;
  if (eachBlocks !== endEachBlocks) {
    errors.push(`Unclosed #each blocks: ${eachBlocks} open, ${endEachBlocks} closed`);
  }

  return {
    valid: errors.length === 0,
    errors,
  };
}

/**
 * Creates a preview of interpolated template with sample data
 */
export function previewTemplate(
  template: string,
  sampleData?: Record<string, unknown>
): string {
  const defaultSample: InterpolationContext = {
    record: {
      id: "sample-123",
      name: "Sample Record",
      email: "sample@example.com",
      amount: 1500.5,
      status: "active",
      created_at: new Date().toISOString(),
      contact: {
        name: "John Doe",
        email: "john@example.com",
      },
      items: [
        { name: "Item 1", price: 100 },
        { name: "Item 2", price: 200 },
      ],
      ...sampleData,
    },
    user: { id: "user-123", email: "user@example.com", name: "Current User" },
    organization: { id: "org-123", name: "My Company" },
    now: new Date(),
  };

  return interpolate(template, defaultSample);
}
