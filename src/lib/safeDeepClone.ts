/**
 * Safe Deep Clone Utility
 * 
 * Provides a stack-safe deep clone implementation that handles large objects
 * without causing "Maximum call stack size exceeded" errors.
 */

/**
 * Deep clone an object using an iterative approach to avoid stack overflow
 * on large objects. Falls back to structuredClone when available.
 */
export function safeDeepClone<T>(obj: T): T {
  if (obj === null || typeof obj !== 'object') {
    return obj;
  }

  // Use structuredClone if available (modern browsers)
  if (typeof structuredClone === 'function') {
    try {
      return structuredClone(obj);
    } catch {
      // Fall through to manual implementation
    }
  }

  // Manual iterative deep clone
  return iterativeDeepClone(obj);
}

/**
 * Iterative deep clone implementation using a stack instead of recursion
 */
function iterativeDeepClone<T>(source: T): T {
  if (source === null || typeof source !== 'object') {
    return source;
  }

  // Create the root clone
  const root = Array.isArray(source) ? [] : {};
  
  // Stack for iterative processing: [source, target, key in target]
  const stack: Array<{
    source: unknown;
    target: Record<string, unknown> | unknown[];
    key: string | number;
  }> = [];
  
  // Map to handle circular references
  const seen = new Map<object, object>();
  seen.set(source as object, root);

  // Initialize stack with root object's properties
  if (Array.isArray(source)) {
    for (let i = source.length - 1; i >= 0; i--) {
      stack.push({ source: source[i], target: root, key: i });
    }
  } else {
    const keys = Object.keys(source as object);
    for (let i = keys.length - 1; i >= 0; i--) {
      const key = keys[i];
      stack.push({ source: (source as Record<string, unknown>)[key], target: root, key });
    }
  }

  // Process stack iteratively
  while (stack.length > 0) {
    const { source: currentSource, target, key } = stack.pop()!;

    // Handle primitives and null
    if (currentSource === null || typeof currentSource !== 'object') {
      (target as Record<string | number, unknown>)[key] = currentSource;
      continue;
    }

    // Handle Date
    if (currentSource instanceof Date) {
      (target as Record<string | number, unknown>)[key] = new Date(currentSource.getTime());
      continue;
    }

    // Handle RegExp
    if (currentSource instanceof RegExp) {
      (target as Record<string | number, unknown>)[key] = new RegExp(currentSource.source, currentSource.flags);
      continue;
    }

    // Handle circular references
    if (seen.has(currentSource as object)) {
      (target as Record<string | number, unknown>)[key] = seen.get(currentSource as object);
      continue;
    }

    // Create new object/array
    const isArray = Array.isArray(currentSource);
    const newTarget = isArray ? [] : {};
    seen.set(currentSource as object, newTarget);
    (target as Record<string | number, unknown>)[key] = newTarget;

    // Add children to stack
    if (isArray) {
      for (let i = currentSource.length - 1; i >= 0; i--) {
        stack.push({ source: currentSource[i], target: newTarget, key: i });
      }
    } else {
      const keys = Object.keys(currentSource as object);
      for (let i = keys.length - 1; i >= 0; i--) {
        const childKey = keys[i];
        stack.push({ 
          source: (currentSource as Record<string, unknown>)[childKey], 
          target: newTarget, 
          key: childKey 
        });
      }
    }
  }

  return root as T;
}

/**
 * Shallow clone with deep clone of specific nested paths
 * Useful when you only need to deep clone certain parts of an object
 */
export function selectiveDeepClone<T extends Record<string, unknown>>(
  obj: T,
  deepPaths: string[]
): T {
  if (obj === null || typeof obj !== 'object') {
    return obj;
  }

  // Start with shallow clone
  const result = { ...obj } as T;

  // Deep clone specified paths
  for (const path of deepPaths) {
    const keys = path.split('.');
    let current: Record<string, unknown> = result;
    
    for (let i = 0; i < keys.length - 1; i++) {
      const key = keys[i];
      if (current[key] && typeof current[key] === 'object') {
        current[key] = { ...(current[key] as Record<string, unknown>) };
        current = current[key] as Record<string, unknown>;
      } else {
        break;
      }
    }

    const lastKey = keys[keys.length - 1];
    if (current[lastKey] !== undefined) {
      current[lastKey] = safeDeepClone(current[lastKey]);
    }
  }

  return result;
}

/**
 * Compare two objects for equality without deep serialization
 * Uses a configurable depth limit to prevent stack overflow
 */
export function shallowEqual<T>(a: T, b: T, maxDepth: number = 2): boolean {
  if (a === b) return true;
  if (a === null || b === null) return false;
  if (typeof a !== 'object' || typeof b !== 'object') return a === b;

  const aKeys = Object.keys(a as object);
  const bKeys = Object.keys(b as object);

  if (aKeys.length !== bKeys.length) return false;

  for (const key of aKeys) {
    const aVal = (a as Record<string, unknown>)[key];
    const bVal = (b as Record<string, unknown>)[key];

    if (maxDepth > 0 && typeof aVal === 'object' && typeof bVal === 'object') {
      if (!shallowEqual(aVal, bVal, maxDepth - 1)) return false;
    } else if (aVal !== bVal) {
      return false;
    }
  }

  return true;
}
