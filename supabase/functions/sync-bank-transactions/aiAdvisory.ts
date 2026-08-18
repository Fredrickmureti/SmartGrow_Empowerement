// AI categorization is ADVISORY ONLY.
//
// Deterministic categorization belongs to the database
// (`bank_transaction_apply_rules`, applied inside
// `bank_statement_import_batch`). What happens here never sets `category`; it
// only fills `ai_suggested_category` / `ai_confidence` / `ai_reasoning` so a
// human reviewer has a hint. No accounting decision depends on it.

import { NormalizedFeedLine } from './providers/types.ts';

const CATEGORIES = [
  'Office Supplies',
  'Travel & Transportation',
  'Meals & Entertainment',
  'Professional Services',
  'Software & Subscriptions',
  'Utilities',
  'Marketing & Advertising',
  'Equipment & Hardware',
  'Insurance',
  'Rent & Facilities',
  'Bank & Finance Charges',
  'Payroll & Wages',
  'Sales Revenue',
  'Customer Payment',
  'Refund',
  'Transfer',
  'Other',
];

export interface AiAdvice {
  ai_suggested_category: string;
  ai_confidence: number;
  ai_reasoning: string;
}

/** Returns `null` whenever the gateway is unavailable or unhelpful. */
export async function suggestCategory(line: NormalizedFeedLine): Promise<AiAdvice | null> {
  const apiKey = Deno.env.get('LOVABLE_API_KEY');
  if (!apiKey) return null;

  try {
    const response = await fetch('https://ai.gateway.lovable.dev/v1/chat/completions', {
      method: 'POST',
      headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'google/gemini-3-flash-preview',
        messages: [
          {
            role: 'system',
            content:
              'You suggest a category for a bank statement line. Your answer is advisory: a human confirms it.',
          },
          {
            role: 'user',
            content:
              `Description: ${line.description ?? ''}\n` +
              `Amount: ${line.amount} (${line.amount >= 0 ? 'money in' : 'money out'})\n` +
              `Reference: ${line.reference ?? 'N/A'}\n\n` +
              `Choose one category from:\n${CATEGORIES.map((c) => `- ${c}`).join('\n')}`,
          },
        ],
        tools: [
          {
            type: 'function',
            function: {
              name: 'categorize_transaction',
              description: 'Suggest a category for a bank transaction',
              parameters: {
                type: 'object',
                properties: {
                  category: { type: 'string' },
                  confidence: { type: 'number' },
                  reasoning: { type: 'string' },
                },
                required: ['category', 'confidence', 'reasoning'],
                additionalProperties: false,
              },
            },
          },
        ],
        tool_choice: { type: 'function', function: { name: 'categorize_transaction' } },
      }),
    });

    if (!response.ok) {
      console.error(`[AI] gateway ${response.status}`);
      return null;
    }

    const data = await response.json();
    const args = data.choices?.[0]?.message?.tool_calls?.[0]?.function?.arguments;
    if (!args) return null;

    const parsed = JSON.parse(args) as { category?: string; confidence?: number; reasoning?: string };
    if (!parsed.category) return null;

    return {
      ai_suggested_category: parsed.category,
      ai_confidence: Math.min(Math.max(Number(parsed.confidence ?? 0), 0), 1),
      ai_reasoning: parsed.reasoning ?? '',
    };
  } catch (error) {
    console.error('[AI] suggestion failed:', error);
    return null;
  }
}

/**
 * Advisory pass over freshly fetched lines, bounded so a large statement never
 * turns into hundreds of model calls inside one request.
 */
export async function annotateLines(
  lines: NormalizedFeedLine[],
  limit = 25,
): Promise<Map<string, AiAdvice>> {
  const out = new Map<string, AiAdvice>();
  if (!Deno.env.get('LOVABLE_API_KEY')) return out;

  for (const line of lines.slice(0, limit)) {
    const advice = await suggestCategory(line);
    if (advice) out.set(line.external_transaction_id, advice);
  }
  return out;
}
