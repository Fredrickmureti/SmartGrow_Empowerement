-- ADR-0110 Phase 6 — one grammar, one matcher (SQL mirror).
--
-- Proves `identity_code_candidates` against the SAME vectors as
-- `src/lib/gs1/identityCodeVectors.ts`. If you add a vector there, add
-- it here in the same change.

DO $$
DECLARE
  v_cases jsonb := $j$[
    {"raw": "  5901234123457  ",
     "expect": ["5901234123457","05901234123457"]},
    {"raw": "05012345678900",
     "expect": ["05012345678900","5012345678900"]},
    {"raw": "012345678905",
     "expect": ["012345678905","12345678905","0012345678905","00012345678905"]},
    {"raw": "12345670",
     "expect": ["12345670","000012345670","0000012345670","00000012345670"]},
    {"raw": "abc-123",
     "expect": ["ABC-123"]},
    {"raw": "   ",
     "expect": []}
  ]$j$;
  v_case jsonb;
  v_got text[];
  v_want text[];
BEGIN
  FOR v_case IN SELECT * FROM jsonb_array_elements(v_cases) LOOP
    v_got  := public.identity_code_candidates(v_case->>'raw');
    v_want := ARRAY(SELECT jsonb_array_elements_text(v_case->'expect'));
    IF v_got IS DISTINCT FROM v_want THEN
      RAISE EXCEPTION 'identity_code_candidates(%) = %, expected %',
        v_case->>'raw', v_got, v_want;
    END IF;
  END LOOP;

  -- GS1 element string: FNC1 separator, AI (01) + AI (10).
  v_got := public.identity_code_candidates('0105012345678900' || chr(29) || '10LOT42');
  IF NOT (v_got @> ARRAY['05012345678900','5012345678900']) THEN
    RAISE EXCEPTION 'GS1 payload did not contribute its GTIN family: %', v_got;
  END IF;

  -- The GS1 grammar must be table-driven, not a hardcoded AI (01) match.
  IF (public.parse_gs1_element_string('0105012345678900' || chr(29) || '10LOT42'))->>'lot'
       IS DISTINCT FROM 'LOT42' THEN
    RAISE EXCEPTION 'parse_gs1_element_string lost AI (10)';
  END IF;

  -- Normalisation is upper(btrim) — never lower().
  IF public.identity_code_candidates(' lmn-500 ') IS DISTINCT FROM ARRAY['LMN-500'] THEN
    RAISE EXCEPTION 'normalisation regressed to lower() or lost btrim';
  END IF;
END $$;
