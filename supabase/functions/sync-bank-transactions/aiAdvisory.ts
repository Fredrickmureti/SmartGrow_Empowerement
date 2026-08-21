// AI categorization is ADVISORY ONLY.
//
// Deterministic categorization belongs to the database
// (`bank_transaction_apply_rules`, applied inside
// `bank_statement_import_batch`). What happens here never sets `category`; it
// only fills `ai_suggested_category` / `ai_confidence` / `ai_reasoning` so a
// human reviewer has a hint. No accounting decision depends on it.

import { NormalizedFeedLine } from './providers/types.ts';

/**
 * Scope tuple every background AI call must carry.
 *
 * A scheduled job has no browser and therefore no UI state to inherit: the
 * tuple is derived server-side from the row the job is working on (here the
 * bank account), never from the request body. `userId` is null for cron runs —
 * the spend belongs to the tenant, not to whoever last opened the page.
 */
export interface AdvisoryScope {
  organizationId: string;
  businessId: string | null;
  branchId: string | null;
  userId: string | null;
  appKey: string;
}

const GATEWAY_PROVIDER_CODE = 'lovable_gateway';
const GATEWAY_MODEL = 'google/gemini-3-flash-preview';

type UsageLogger = {
  from: (table: string) => { insert: (row: Record<string, unknown>) => Promise<unknown> };
};

/** Attributes one advisory model call to the tenant that caused it. */
async function logAdvisoryUsage(
  client: UsageLogger,
  scope: AdvisoryScope,
  outcome: { responseTimeMs: number; error?: string | null; rateLimited?: boolean },
): Promise<void> {
  try {
    await client.from('ai_usage_logs').insert({
      provider_code: GATEWAY_PROVIDER_CODE,
      request_type: 'bank_transaction_categorization',
      model_used: GATEWAY_MODEL,
      response_time_ms: outcome.responseTimeMs,
      was_rate_limited: outcome.rateLimited ?? false,
      error_message: outcome.error ?? null,
      organization_id: scope.organizationId,
      business_id: scope.businessId,
      branch_id: scope.branchId,
      user_id: scope.userId,
      app_key: scope.appKey,
    });
  } catch (error) {
    // Never let accounting-irrelevant telemetry break a feed run.
    console.error('[AI] usage log failed:', error);
  }
}

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
export async function suggestCategory(
  line: NormalizedFeedLine,
  client: UsageLogger,
  scope: AdvisoryScope,
): Promise<AiAdvice | null> {
  const apiKey = Deno.env.get('LOVABLE_API_KEY');
  if (!apiKey) return null;

  const startedAt = Date.now();
  try {
    const response = await fetch('https://ai.gateway.lovable.dev/v1/chat/completions', {
      method: 'POST',
      headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: GATEWAY_MODEL,
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
      await logAdvisoryUsage(client, scope, {
        responseTimeMs: Date.now() - startedAt,
        error: `gateway_${response.status}`,
        rateLimited: response.status === 429,
      });
      return null;
    }

    const data = await response.json();
    await logAdvisoryUsage(client, scope, { responseTimeMs: Date.now() - startedAt });
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
    await logAdvisoryUsage(client, scope, {
      responseTimeMs: Date.now() - startedAt,
      error: error instanceof Error ? error.message.slice(0, 500) : 'unknown_error',
    });
    return null;
  }
}

/**
 * Advisory pass over freshly fetched lines, bounded so a large statement never
 * turns into hundreds of model calls inside one request.
 */
export async function annotateLines(
  client: UsageLogger,
  lines: NormalizedFeedLine[],
  scope: AdvisoryScope,
  limit = 25,
): Promise<Map<string, AiAdvice>> {
  const out = new Map<string, AiAdvice>();
  if (!Deno.env.get('LOVABLE_API_KEY')) return out;
  // Fail closed on an undeterminable scope: an AI call we cannot attribute to a
  // tenant does not happen.
  if (!scope.organizationId) {
    console.error('[AI] advisory skipped: no resolved scope');
    return out;
  }

  for (const line of lines.slice(0, limit)) {
    const advice = await suggestCategory(line, client, scope);
    if (advice) out.set(line.external_transaction_id, advice);
  }
  return out;
}
