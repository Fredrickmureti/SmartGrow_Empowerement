/**
 * AI Response Parser
 * 
 * Robust utilities for parsing AI responses, extracting JSON,
 * and handling common formatting issues.
 */

export interface ParsedSuggestion {
  suggestedRange?: string;
  suggestedChartType?: string;
  suggestedRowGroupBy?: string[];
  suggestedColGroupBy?: string[];
  suggestedMeasureField?: string;
  suggestedAggregator?: string;
  suggestedAnchorCell?: string;
  reasoning?: string;
  dataQualityNotes?: string[];
  confidence?: number;
  [key: string]: unknown;
}

export interface ParseResult<T = ParsedSuggestion> {
  success: boolean;
  data?: T;
  error?: string;
  cleanedContent: string;
}

/**
 * Extract JSON from AI response that may contain markdown or other text
 */
export function extractJsonFromResponse<T = ParsedSuggestion>(response: string): ParseResult<T> {
  if (!response || typeof response !== 'string') {
    return {
      success: false,
      error: 'Empty or invalid response',
      cleanedContent: '',
    };
  }

  let cleanedContent = response;

  // Step 1: Try to extract from markdown code blocks first
  const codeBlockMatch = response.match(/```(?:json)?\s*([\s\S]*?)\s*```/);
  if (codeBlockMatch) {
    try {
      const parsed = parseJsonSafe<T>(codeBlockMatch[1]);
      if (parsed) {
        // Remove the JSON block from content for display
        cleanedContent = response.replace(/```(?:json)?\s*[\s\S]*?\s*```/g, '').trim();
        return {
          success: true,
          data: parsed,
          cleanedContent,
        };
      }
    } catch {
      // Continue to other methods
    }
  }

  // Step 2: Try to find JSON object boundaries
  const jsonStart = response.indexOf('{');
  const jsonEnd = response.lastIndexOf('}');
  
  if (jsonStart !== -1 && jsonEnd !== -1 && jsonEnd > jsonStart) {
    const potentialJson = response.substring(jsonStart, jsonEnd + 1);
    
    try {
      const parsed = parseJsonSafe<T>(potentialJson);
      if (parsed) {
        // Remove the JSON from content for display
        cleanedContent = (response.substring(0, jsonStart) + response.substring(jsonEnd + 1)).trim();
        return {
          success: true,
          data: parsed,
          cleanedContent,
        };
      }
    } catch {
      // Continue to other methods
    }
  }

  // Step 3: Try to find JSON array boundaries
  const arrayStart = response.indexOf('[');
  const arrayEnd = response.lastIndexOf(']');
  
  if (arrayStart !== -1 && arrayEnd !== -1 && arrayEnd > arrayStart) {
    // Only if there's no object or the array comes first
    if (jsonStart === -1 || arrayStart < jsonStart) {
      const potentialJson = response.substring(arrayStart, arrayEnd + 1);
      
      try {
        const parsed = parseJsonSafe<T>(potentialJson);
        if (parsed) {
          cleanedContent = (response.substring(0, arrayStart) + response.substring(arrayEnd + 1)).trim();
          return {
            success: true,
            data: parsed,
            cleanedContent,
          };
        }
      } catch {
        // No valid JSON found
      }
    }
  }

  // No JSON found - return original content
  return {
    success: false,
    error: 'No valid JSON found in response',
    cleanedContent: response,
  };
}

/**
 * Parse JSON with error recovery for common issues
 */
function parseJsonSafe<T>(jsonString: string): T | null {
  if (!jsonString || typeof jsonString !== 'string') {
    return null;
  }

  let cleaned = jsonString.trim();

  // Try parsing as-is first
  try {
    return JSON.parse(cleaned) as T;
  } catch {
    // Continue with cleaning
  }

  // Fix common issues
  cleaned = cleaned
    // Remove trailing commas before closing brackets
    .replace(/,\s*}/g, '}')
    .replace(/,\s*]/g, ']')
    // Remove control characters
    .replace(/[\x00-\x1F\x7F]/g, '')
    // Fix unescaped newlines in strings (common AI issue)
    .replace(/:\s*"([^"]*)\n([^"]*)"/g, (_, p1, p2) => `: "${p1}\\n${p2}"`)
    // Remove BOM and other invisible characters
    .replace(/^\uFEFF/, '')
    .trim();

  try {
    return JSON.parse(cleaned) as T;
  } catch {
    return null;
  }
}

/**
 * Clean AI response content for display (remove raw JSON blocks)
 */
export function cleanResponseForDisplay(response: string): string {
  if (!response) return '';

  let cleaned = response;

  // Remove JSON code blocks
  cleaned = cleaned.replace(/```(?:json)?\s*[\s\S]*?\s*```/g, '');

  // Remove inline JSON objects that look like suggestions
  // Only remove if they contain suggestion-related keys
  const jsonPattern = /\{[\s\S]*?"(?:suggested|reasoning|confidence|dataQuality)"[\s\S]*?\}/g;
  cleaned = cleaned.replace(jsonPattern, '');

  // Clean up extra whitespace
  cleaned = cleaned
    .replace(/\n{3,}/g, '\n\n')
    .trim();

  return cleaned;
}

/**
 * Validate and normalize a suggestion object
 */
export function normalizeSuggestion(raw: unknown): ParsedSuggestion | null {
  if (!raw || typeof raw !== 'object') {
    return null;
  }

  const suggestion = raw as Record<string, unknown>;
  const normalized: ParsedSuggestion = {};

  // Normalize string fields
  if (typeof suggestion.suggestedRange === 'string') {
    normalized.suggestedRange = suggestion.suggestedRange;
  }
  if (typeof suggestion.suggestedChartType === 'string') {
    normalized.suggestedChartType = suggestion.suggestedChartType.toLowerCase();
  }
  if (typeof suggestion.suggestedMeasureField === 'string') {
    normalized.suggestedMeasureField = suggestion.suggestedMeasureField;
  }
  if (typeof suggestion.suggestedAggregator === 'string') {
    normalized.suggestedAggregator = suggestion.suggestedAggregator.toLowerCase();
  }
  if (typeof suggestion.suggestedAnchorCell === 'string') {
    normalized.suggestedAnchorCell = suggestion.suggestedAnchorCell.toUpperCase();
  }
  if (typeof suggestion.reasoning === 'string') {
    normalized.reasoning = suggestion.reasoning;
  }

  // Normalize array fields
  if (Array.isArray(suggestion.suggestedRowGroupBy)) {
    normalized.suggestedRowGroupBy = suggestion.suggestedRowGroupBy.filter(
      (v): v is string => typeof v === 'string'
    );
  }
  if (Array.isArray(suggestion.suggestedColGroupBy)) {
    normalized.suggestedColGroupBy = suggestion.suggestedColGroupBy.filter(
      (v): v is string => typeof v === 'string'
    );
  }
  if (Array.isArray(suggestion.dataQualityNotes)) {
    normalized.dataQualityNotes = suggestion.dataQualityNotes.filter(
      (v): v is string => typeof v === 'string'
    );
  }

  // Normalize numeric fields
  if (typeof suggestion.confidence === 'number') {
    normalized.confidence = Math.max(0, Math.min(1, suggestion.confidence));
  }

  // Check if we have any valid suggestions
  const hasValidContent = 
    normalized.suggestedRange ||
    normalized.suggestedChartType ||
    (normalized.suggestedRowGroupBy && normalized.suggestedRowGroupBy.length > 0) ||
    (normalized.suggestedColGroupBy && normalized.suggestedColGroupBy.length > 0) ||
    normalized.suggestedMeasureField ||
    normalized.suggestedAggregator ||
    normalized.suggestedAnchorCell;

  return hasValidContent ? normalized : null;
}

/**
 * Parse and normalize an AI response into suggestion + display content
 */
export function parseAIResponse(response: string): {
  suggestion: ParsedSuggestion | null;
  displayContent: string;
} {
  const result = extractJsonFromResponse(response);
  
  if (result.success && result.data) {
    const normalized = normalizeSuggestion(result.data);
    return {
      suggestion: normalized,
      displayContent: result.cleanedContent || response,
    };
  }

  return {
    suggestion: null,
    displayContent: response,
  };
}

/**
 * Extract formula suggestions from AI response
 */
export function extractFormulaSuggestions(content: string): Array<{
  formula: string;
  description: string;
  confidence: number;
}> {
  const suggestions: Array<{
    formula: string;
    description: string;
    confidence: number;
  }> = [];

  // Look for formulas in code blocks or inline backticks
  const formulaRegex = /`(=[\w\d\(\):,.\+\-\*\/\$\s]+)`/g;
  let match;

  while ((match = formulaRegex.exec(content)) !== null) {
    const formula = match[1].trim();
    
    // Skip if already added
    if (suggestions.some(s => s.formula === formula)) continue;
    
    suggestions.push({
      formula,
      description: 'Formula from AI',
      confidence: 0.9,
    });
  }

  return suggestions;
}
