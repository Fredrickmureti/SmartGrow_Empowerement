import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'
import { encode as base64Encode } from "https://deno.land/std@0.208.0/encoding/base64.ts"

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type, x-supabase-client-platform, x-supabase-client-platform-version, x-supabase-client-runtime, x-supabase-client-runtime-version',
}

interface BankProvider {
  id: string
  provider_code: string
  provider_name: string
  api_base_url: string | null
  api_key_encrypted: string | null
  api_secret_encrypted: string | null
  merchant_code: string | null
  public_key: string | null
  private_key_encrypted: string | null
  is_sandbox: boolean
  config: Record<string, any>
}

interface BankAccount {
  id: string
  organization_id: string
  name: string
  bank_name: string | null
  account_number: string | null
  external_account_id: string | null
  provider_id: string | null
  access_token_encrypted: string | null
  refresh_token_encrypted: string | null
  sync_from_date: string | null
  currency: string
}

interface JengaTransaction {
  reference: string
  date: string
  description: string
  amount: string
  serial: string
  postedDateTime: string
  type: string
  runningBalance: {
    currency: string
    amount: number
  }
}

// Generate signature for Jenga API using private key
async function generateJengaSignature(data: string, privateKey: string): Promise<string> {
  try {
    // Import the private key
    const pemContent = privateKey
      .replace('-----BEGIN PRIVATE KEY-----', '')
      .replace('-----END PRIVATE KEY-----', '')
      .replace('-----BEGIN RSA PRIVATE KEY-----', '')
      .replace('-----END RSA PRIVATE KEY-----', '')
      .replace(/\s/g, '')
    
    const binaryKey = Uint8Array.from(atob(pemContent), c => c.charCodeAt(0))
    
    const cryptoKey = await crypto.subtle.importKey(
      'pkcs8',
      binaryKey,
      {
        name: 'RSASSA-PKCS1-v1_5',
        hash: 'SHA-256',
      },
      false,
      ['sign']
    )
    
    // Sign the data
    const encoder = new TextEncoder()
    const dataBuffer = encoder.encode(data)
    const signature = await crypto.subtle.sign('RSASSA-PKCS1-v1_5', cryptoKey, dataBuffer)
    
    return base64Encode(new Uint8Array(signature))
  } catch (error) {
    console.error('[Jenga] Signature generation error:', error)
    throw new Error('Failed to generate signature')
  }
}

// Get Jenga OAuth token
async function getJengaAccessToken(
  provider: BankProvider
): Promise<string | null> {
  const baseUrl = provider.is_sandbox 
    ? 'https://uat.finserve.africa' 
    : 'https://api.finserve.africa'
  
  const tokenUrl = `${baseUrl}/authentication/api/v3/authenticate/merchant`
  
  console.log(`[Jenga] Getting access token from ${tokenUrl}`)
  
  try {
    const response = await fetch(tokenUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Api-Key': provider.api_key_encrypted || '',
      },
      body: JSON.stringify({
        merchantCode: provider.merchant_code,
        consumerSecret: provider.api_secret_encrypted,
      }),
    })
    
    if (!response.ok) {
      const errorText = await response.text()
      console.error(`[Jenga] Token error: ${response.status} - ${errorText}`)
      return null
    }
    
    const data = await response.json()
    console.log('[Jenga] Token obtained successfully')
    return data.accessToken || data.access_token
  } catch (error) {
    console.error('[Jenga] Token fetch error:', error)
    return null
  }
}

// Fetch account balance from Jenga
async function fetchJengaAccountBalance(
  provider: BankProvider,
  account: BankAccount,
  accessToken: string
): Promise<number | null> {
  const baseUrl = provider.is_sandbox 
    ? 'https://uat.finserve.africa' 
    : 'https://api.finserve.africa'
  
  const countryCode = 'KE'
  const accountNumber = account.account_number || account.external_account_id || ''
  
  // Signature: countryCode + accountId
  const signatureData = `${countryCode}${accountNumber}`
  
  console.log(`[Jenga] Fetching balance for account ${accountNumber}`)
  console.log(`[Jenga] Signature data: ${signatureData}`)
  
  try {
    let signature = ''
    if (provider.private_key_encrypted) {
      signature = await generateJengaSignature(signatureData, provider.private_key_encrypted)
    }
    
    const balanceUrl = `${baseUrl}/v3-apis/account-api/v3.0/accounts/balances/${countryCode}/${accountNumber}`
    console.log(`[Jenga] Balance URL: ${balanceUrl}`)
    
    const response = await fetch(
      balanceUrl,
      {
        method: 'GET',
        headers: {
          'Authorization': `Bearer ${accessToken}`,
          'Content-Type': 'application/json',
          'signature': signature,
        },
      }
    )
    
    if (!response.ok) {
      const errorText = await response.text()
      console.error(`[Jenga] Balance error: ${response.status} - ${errorText}`)
      return null
    }
    
    const data = await response.json()
    console.log('[Jenga] Balance response:', JSON.stringify(data))
    
    // Handle different response structures
    if (data.data?.balances) {
      // Find available balance
      const availableBalance = data.data.balances.find((b: any) => b.type === 'Available')
      return availableBalance?.amount || data.data.balances[0]?.amount || null
    }
    
    return data.balance || data.availableBalance || null
  } catch (error) {
    console.error('[Jenga] Balance fetch error:', error)
    return null
  }
}

// Fetch transactions from Jenga (Account Full Statement)
async function fetchJengaTransactions(
  provider: BankProvider,
  account: BankAccount,
  fromDate: string,
  toDate: string
): Promise<any[]> {
  console.log(`[Jenga] Fetching transactions for account ${account.account_number}`)
  console.log(`[Jenga] Date range: ${fromDate} to ${toDate}`)
  console.log(`[Jenga] Using merchant code: ${provider.merchant_code}`)
  
  // Get access token first
  const accessToken = await getJengaAccessToken(provider)
  if (!accessToken) {
    console.error('[Jenga] Failed to get access token')
    return []
  }
  
  const baseUrl = provider.is_sandbox 
    ? 'https://uat.finserve.africa' 
    : 'https://api.finserve.africa'
  
  const countryCode = 'KE'
  const accountNumber = account.account_number || account.external_account_id || ''
  
  // Signature for account statement: accountNumber + countryCode + toDate
  const signatureData = `${accountNumber}${countryCode}${toDate}`
  
  try {
    let signature = ''
    if (provider.private_key_encrypted) {
      signature = await generateJengaSignature(signatureData, provider.private_key_encrypted)
    }
    
    const statementUrl = `${baseUrl}/v3-apis/account-api/v3.0/accounts/fullStatement`
    console.log(`[Jenga] Full statement URL: ${statementUrl}`)
    
    const response = await fetch(
      statementUrl,
      {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${accessToken}`,
          'Content-Type': 'application/json',
          'signature': signature,
        },
        body: JSON.stringify({
          countryCode,
          accountNumber,
          fromDate,
          toDate,
        }),
      }
    )
    
    if (!response.ok) {
      const errorText = await response.text()
      console.error(`[Jenga] Statement error: ${response.status} - ${errorText}`)
      
      // Try mini statement as fallback
      return await fetchJengaMiniStatement(provider, account, accessToken, baseUrl)
    }
    
    const data = await response.json()
    console.log('[Jenga] Statement response received')
    
    // Transform Jenga transactions to our format
    const transactions = (data.data?.transactions || data.transactions || []).map((tx: JengaTransaction) => ({
      external_transaction_id: tx.reference || tx.serial || `jenga_${Date.now()}_${Math.random()}`,
      transaction_date: tx.date || tx.postedDateTime,
      posting_date: tx.postedDateTime || tx.date,
      description: tx.description,
      reference: tx.reference,
      amount: parseFloat(tx.amount) * (tx.type === 'Debit' ? -1 : 1),
      balance_after: tx.runningBalance?.amount,
      raw_data: tx,
    }))
    
    return transactions
  } catch (error) {
    console.error('[Jenga] Statement fetch error:', error)
    return []
  }
}

// Fetch mini statement as fallback
async function fetchJengaMiniStatement(
  provider: BankProvider,
  account: BankAccount,
  accessToken: string,
  baseUrl: string
): Promise<any[]> {
  console.log('[Jenga] Trying mini statement as fallback')
  
  const countryCode = 'KE'
  const accountNumber = account.account_number || account.external_account_id || ''
  
  // Signature for mini statement: countryCode + accountNumber
  const signatureData = `${countryCode}${accountNumber}`
  
  try {
    let signature = ''
    if (provider.private_key_encrypted) {
      signature = await generateJengaSignature(signatureData, provider.private_key_encrypted)
    }
    
    const miniStatementUrl = `${baseUrl}/v3-apis/account-api/v3.0/accounts/miniStatement/${countryCode}/${accountNumber}`
    console.log(`[Jenga] Mini statement URL: ${miniStatementUrl}`)
    
    const response = await fetch(
      miniStatementUrl,
      {
        method: 'GET',
        headers: {
          'Authorization': `Bearer ${accessToken}`,
          'Content-Type': 'application/json',
          'signature': signature,
        },
      }
    )
    
    if (!response.ok) {
      const errorText = await response.text()
      console.error(`[Jenga] Mini statement error: ${response.status} - ${errorText}`)
      return []
    }
    
    const data = await response.json()
    console.log('[Jenga] Mini statement response received')
    
    const transactions = (data.data?.transactions || data.transactions || []).map((tx: any) => ({
      external_transaction_id: tx.reference || tx.chequeNumber || `jenga_mini_${Date.now()}_${Math.random()}`,
      transaction_date: tx.date,
      posting_date: tx.date,
      description: tx.description,
      reference: tx.reference,
      amount: parseFloat(tx.amount) * (tx.type === 'Debit' ? -1 : 1),
      balance_after: null,
      raw_data: tx,
    }))
    
    return transactions
  } catch (error) {
    console.error('[Jenga] Mini statement error:', error)
    return []
  }
}

// Other bank providers - placeholder implementations
async function fetchKCBTransactions(
  provider: BankProvider,
  account: BankAccount,
  fromDate: string,
  toDate: string
): Promise<any[]> {
  console.log(`[KCB BUNI] Fetching transactions for account ${account.account_number}`)
  console.log(`[KCB BUNI] Date range: ${fromDate} to ${toDate}`)
  // TODO: Implement KCB BUNI API integration
  return []
}

async function fetchCoopTransactions(
  provider: BankProvider,
  account: BankAccount,
  fromDate: string,
  toDate: string
): Promise<any[]> {
  console.log(`[Co-op Connect] Fetching transactions for account ${account.account_number}`)
  console.log(`[Co-op Connect] Date range: ${fromDate} to ${toDate}`)
  // TODO: Implement Co-op Connect API integration
  return []
}

async function fetchNCBATransactions(
  provider: BankProvider,
  account: BankAccount,
  fromDate: string,
  toDate: string
): Promise<any[]> {
  console.log(`[NCBA] Fetching transactions for account ${account.account_number}`)
  console.log(`[NCBA] Date range: ${fromDate} to ${toDate}`)
  // TODO: Implement NCBA Open Banking API integration
  return []
}

async function fetchAbsaTransactions(
  provider: BankProvider,
  account: BankAccount,
  fromDate: string,
  toDate: string
): Promise<any[]> {
  console.log(`[Absa] Fetching transactions for account ${account.account_number}`)
  console.log(`[Absa] Date range: ${fromDate} to ${toDate}`)
  // TODO: Implement Absa Open Banking API integration
  return []
}

async function fetchStanChartTransactions(
  provider: BankProvider,
  account: BankAccount,
  fromDate: string,
  toDate: string
): Promise<any[]> {
  console.log(`[StanChart] Fetching transactions for account ${account.account_number}`)
  console.log(`[StanChart] Date range: ${fromDate} to ${toDate}`)
  // TODO: Implement Standard Chartered API integration
  return []
}

async function fetchIMBankTransactions(
  provider: BankProvider,
  account: BankAccount,
  fromDate: string,
  toDate: string
): Promise<any[]> {
  console.log(`[I&M Bank] Fetching transactions for account ${account.account_number}`)
  console.log(`[I&M Bank] Date range: ${fromDate} to ${toDate}`)
  // TODO: Implement I&M Bank API integration
  return []
}

async function fetchStanbicTransactions(
  provider: BankProvider,
  account: BankAccount,
  fromDate: string,
  toDate: string
): Promise<any[]> {
  console.log(`[Stanbic] Fetching transactions for account ${account.account_number}`)
  console.log(`[Stanbic] Date range: ${fromDate} to ${toDate}`)
  // TODO: Implement Stanbic API integration
  return []
}

async function fetchDTBAstraTransactions(
  provider: BankProvider,
  account: BankAccount,
  fromDate: string,
  toDate: string
): Promise<any[]> {
  console.log(`[DTB Astra] Fetching transactions for account ${account.account_number}`)
  console.log(`[DTB Astra] Date range: ${fromDate} to ${toDate}`)
  // TODO: Implement DTB via Astra Africa API integration
  return []
}

// Categorize transaction based on rules
async function categorizeTransaction(
  supabase: any,
  organizationId: string,
  transaction: any
): Promise<{ category: string; confidence: number; ai_suggested?: string; ai_confidence?: number; ai_reasoning?: string }> {
  try {
    const { data: rules } = await supabase
      .from('transaction_categorization_rules')
      .select('*')
      .eq('organization_id', organizationId)
      .eq('is_active', true)
      .order('priority', { ascending: false })

    if (rules && rules.length > 0) {
      for (const rule of rules) {
        if (rule.transaction_type !== 'both' && rule.transaction_type !== transaction.transaction_type) {
          continue
        }

        if (rule.min_amount && Math.abs(transaction.amount) < rule.min_amount) {
          continue
        }
        if (rule.max_amount && Math.abs(transaction.amount) > rule.max_amount) {
          continue
        }

        if (rule.description_pattern) {
          const pattern = new RegExp(rule.description_pattern, 'i')
          if (pattern.test(transaction.description)) {
            return { category: rule.target_category, confidence: 0.9 }
          }
        }

        if (rule.reference_pattern && transaction.reference) {
          const pattern = new RegExp(rule.reference_pattern, 'i')
          if (pattern.test(transaction.reference)) {
            return { category: rule.target_category, confidence: 0.85 }
          }
        }
      }
    }

    // No rule matched - try AI categorization
    const aiResult = await getAICategorization(transaction)
    if (aiResult) {
      return {
        category: aiResult.category,
        confidence: aiResult.confidence,
        ai_suggested: aiResult.category,
        ai_confidence: aiResult.confidence,
        ai_reasoning: aiResult.reasoning,
      }
    }
  } catch (error) {
    console.log('[Categorize] Error during categorization:', error)
  }

  return { category: 'Uncategorized', confidence: 0 }
}

// AI-powered categorization using Lovable AI Gateway
async function getAICategorization(
  transaction: any
): Promise<{ category: string; confidence: number; reasoning: string } | null> {
  const LOVABLE_API_KEY = Deno.env.get('LOVABLE_API_KEY')
  if (!LOVABLE_API_KEY) {
    console.log('[AI] No LOVABLE_API_KEY configured, skipping AI categorization')
    return null
  }

  try {
    const prompt = `Categorize this bank transaction:
Description: ${transaction.description}
Amount: ${transaction.amount}
Type: ${transaction.amount > 0 ? 'credit (money in)' : 'debit (money out)'}
Reference: ${transaction.reference || 'N/A'}

Choose the most appropriate category from this list:
- Office Supplies
- Travel & Transportation
- Meals & Entertainment
- Professional Services
- Software & Subscriptions
- Utilities
- Marketing & Advertising
- Equipment & Hardware
- Insurance
- Rent & Facilities
- Bank & Finance Charges
- Payroll & Wages
- Sales Revenue
- Customer Payment
- Refund
- Transfer
- Other`

    const response = await fetch('https://ai.gateway.lovable.dev/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${LOVABLE_API_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: 'google/gemini-3-flash-preview',
        messages: [
          {
            role: 'system',
            content: 'You are a financial categorization assistant. Analyze bank transactions and categorize them accurately.',
          },
          { role: 'user', content: prompt },
        ],
        tools: [
          {
            type: 'function',
            function: {
              name: 'categorize_transaction',
              description: 'Categorize a bank transaction',
              parameters: {
                type: 'object',
                properties: {
                  category: {
                    type: 'string',
                    description: 'The category for this transaction',
                  },
                  confidence: {
                    type: 'number',
                    description: 'Confidence score between 0 and 1',
                  },
                  reasoning: {
                    type: 'string',
                    description: 'Brief explanation for the categorization',
                  },
                },
                required: ['category', 'confidence', 'reasoning'],
              },
            },
          },
        ],
        tool_choice: { type: 'function', function: { name: 'categorize_transaction' } },
      }),
    })

    if (!response.ok) {
      console.error('[AI] Gateway error:', response.status)
      return null
    }

    const data = await response.json()
    const toolCall = data.choices?.[0]?.message?.tool_calls?.[0]
    
    if (toolCall?.function?.arguments) {
      const result = JSON.parse(toolCall.function.arguments)
      console.log('[AI] Categorized as:', result.category, 'confidence:', result.confidence)
      return {
        category: result.category,
        confidence: Math.min(Math.max(result.confidence, 0), 1),
        reasoning: result.reasoning,
      }
    }
  } catch (error) {
    console.error('[AI] Categorization error:', error)
  }

  return null
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response(null, { headers: corsHeaders })
  }

  try {
    const supabaseUrl = Deno.env.get('SUPABASE_URL')!
    const supabaseServiceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
    const supabase = createClient(supabaseUrl, supabaseServiceKey)

    const { bank_account_id, organization_id } = await req.json()

    if (!bank_account_id || !organization_id) {
      return new Response(
        JSON.stringify({ error: 'bank_account_id and organization_id are required' }),
        { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      )
    }

    // ─── Subscription entitlement check ───
    const { checkAppEntitlement, entitlementDeniedResponse } = await import("../_shared/entitlementCheck.ts");
    const entResult = await checkAppEntitlement(supabase, organization_id, "banking");
    if (!entResult.allowed) return entitlementDeniedResponse(entResult, corsHeaders);

    console.log(`[Sync] Starting sync for bank account: ${bank_account_id}`)

    await supabase
      .from('bank_accounts')
      .update({ sync_status: 'syncing', sync_error: null })
      .eq('id', bank_account_id)

    const { data: account, error: accountError } = await supabase
      .from('bank_accounts')
      .select('*, platform_bank_providers(*)')
      .eq('id', bank_account_id)
      .single()

    if (accountError || !account) {
      console.error('[Sync] Account not found:', accountError)
      await supabase
        .from('bank_accounts')
        .update({ sync_status: 'error', sync_error: 'Account not found' })
        .eq('id', bank_account_id)
      
      return new Response(
        JSON.stringify({ error: 'Bank account not found' }),
        { status: 404, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      )
    }

    const provider = account.platform_bank_providers as BankProvider | null

    const toDate = new Date().toISOString().split('T')[0]
    const fromDate = account.sync_from_date || 
      new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString().split('T')[0]

    let transactions: any[] = []
    let newBalance: number | null = null

    if (provider) {
      switch (provider.provider_code) {
        case 'jenga':
          // First try to get balance
          const accessToken = await getJengaAccessToken(provider)
          if (accessToken) {
            newBalance = await fetchJengaAccountBalance(provider, account, accessToken)
            console.log(`[Jenga] Fetched balance: ${newBalance}`)
          }
          transactions = await fetchJengaTransactions(provider, account, fromDate, toDate)
          break
        case 'kcb_buni':
          transactions = await fetchKCBTransactions(provider, account, fromDate, toDate)
          break
        case 'coop_connect':
          transactions = await fetchCoopTransactions(provider, account, fromDate, toDate)
          break
        case 'ncba':
          transactions = await fetchNCBATransactions(provider, account, fromDate, toDate)
          break
        case 'absa':
          transactions = await fetchAbsaTransactions(provider, account, fromDate, toDate)
          break
        case 'stanchart':
          transactions = await fetchStanChartTransactions(provider, account, fromDate, toDate)
          break
        case 'im_bank':
          transactions = await fetchIMBankTransactions(provider, account, fromDate, toDate)
          break
        case 'stanbic':
          transactions = await fetchStanbicTransactions(provider, account, fromDate, toDate)
          break
        case 'dtb_astra':
          transactions = await fetchDTBAstraTransactions(provider, account, fromDate, toDate)
          break
        default:
          console.log(`[Sync] Unknown provider: ${provider.provider_code}`)
      }
    } else {
      console.log('[Sync] No provider configured for this account - manual import only')
    }

    console.log(`[Sync] Fetched ${transactions.length} transactions`)

    // Provider feeds and manual file imports share ONE ingestion engine.
    // This function's job ends at "fetch and classify"; the database owns
    // persistence: dedup identity, lifecycle + fiscal-period gates, rule
    // categorization, statement bookkeeping and the business event, all in
    // a single transaction. Scope columns (business_id / branch_id) are
    // derived server-side from the parent account, never trusted from here.
    const rows: Record<string, unknown>[] = []
    for (const tx of transactions) {
      const categorization = await categorizeTransaction(supabase, organization_id, tx)
      rows.push({
        external_transaction_id: tx.external_transaction_id,
        transaction_date: tx.transaction_date,
        posting_date: tx.posting_date,
        description: tx.description,
        reference: tx.reference,
        amount: tx.amount,
        balance_after: tx.balance_after,
        category: categorization.category,
        category_confidence: categorization.confidence,
        ai_suggested_category: categorization.ai_suggested ?? null,
        ai_confidence: categorization.ai_suggested ? categorization.ai_confidence : null,
        ai_reasoning: categorization.ai_suggested ? categorization.ai_reasoning : null,
        raw_data: tx.raw_data || tx,
      })
    }

    let newCount = 0
    let duplicateCount = 0
    let rejectedCount = 0

    if (rows.length > 0) {
      const { data: importResult, error: importError } = await supabase.rpc(
        'bank_statement_import_batch',
        {
          _bank_account_id: bank_account_id,
          _rows: rows,
          _statement: {
            file_name: `${provider?.provider_code ?? 'feed'} ${fromDate}..${toDate}`,
            file_hash: `feed_${bank_account_id}_${fromDate}_${toDate}`,
            file_format: 'provider_feed',
          },
          _source: `feed:${provider?.provider_code ?? 'unknown'}`,
        }
      )

      if (importError) throw importError

      newCount = (importResult as any)?.inserted ?? 0
      duplicateCount = (importResult as any)?.duplicates ?? 0
      rejectedCount = (importResult as any)?.rejected ?? 0
    }


    // Update account with latest sync info and balance if fetched
    const updateData: Record<string, any> = {
      sync_status: 'synced',
      last_sync_at: new Date().toISOString(),
      sync_error: null,
    }
    
    if (newBalance !== null) {
      updateData.current_balance = newBalance
    }

    await supabase
      .from('bank_accounts')
      .update(updateData)
      .eq('id', bank_account_id)

    console.log(`[Sync] Completed: ${newCount} new, ${updatedCount} updated${newBalance !== null ? `, balance: ${newBalance}` : ''}`)

    return new Response(
      JSON.stringify({
        success: true,
        new_transactions: newCount,
        updated_transactions: updatedCount,
        total_fetched: transactions.length,
        balance_updated: newBalance !== null,
        new_balance: newBalance,
      }),
      { headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    )

  } catch (error) {
    console.error('[Sync] Error:', error)
    
    return new Response(
      JSON.stringify({ error: error instanceof Error ? error.message : 'Internal server error' }),
      { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    )
  }
})