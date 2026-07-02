/**
 * Wave B1 Step 1 — contract test for the `print_policies_resolve` RPC
 * (ADR-0026). Asserts the row shape the rest of `PrintClient.print()` will
 * consume in Step 2. Drift between the SQL function and the generated
 * Supabase types fails this test at compile-time.
 *
 * Known generator limitation: the Supabase type generator infers all RPC
 * return columns as non-nullable strings, even when the SQL function can
 * return NULL (here: `printer_profile_id` when no policy matches). The
 * runtime contract is documented in the migration and enforced by callers
 * who treat empty/falsy as "no profile".
 */
import { describe, expect, it } from 'vitest';
import type { Database } from '@/integrations/supabase/types';

type Fn = Database['public']['Functions']['print_policies_resolve'];
type Args = Fn['Args'];
type ReturnRow = Fn['Returns'][number];

describe('print_policies_resolve RPC contract', () => {
  it('accepts the four ADR-0026 arguments', () => {
    const args: Args = {
      p_business_id: '00000000-0000-0000-0000-000000000000',
      p_branch_id: '00000000-0000-0000-0000-000000000000',
      p_document_type: 'invoice',
      p_intent: 'original',
    };
    expect(args.p_document_type).toBe('invoice');
    expect(args.p_intent).toBe('original');
  });

  it('returns the ADR-0026 row shape', () => {
    const row: ReturnRow = {
      printer_profile_id: '',
      paper_format: 'a4',
      render_mode: 'pdf',
      copies: 1,
      auto_print: false,
      ask_user: true,
    };

    // Field-by-field type assertions — any drift in the migration that
    // changes column names or types breaks this typecheck.
    const printerProfileId: string = row.printer_profile_id;
    const paperFormat: string = row.paper_format;
    const renderMode: string = row.render_mode;
    const copies: number = row.copies;
    const autoPrint: boolean = row.auto_print;
    const askUser: boolean = row.ask_user;

    expect([printerProfileId, paperFormat, renderMode, copies, autoPrint, askUser]).toEqual([
      '',
      'a4',
      'pdf',
      1,
      false,
      true,
    ]);
  });
});
