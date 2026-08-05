CREATE OR REPLACE FUNCTION public.parse_gs1_element_string(p_raw text)
RETURNS jsonb
LANGUAGE plpgsql IMMUTABLE
SET search_path TO 'public'
AS $$
DECLARE
  FNC1 constant text := chr(29);
  v_in text := coalesce(p_raw, '');
  v_cursor int := 1;
  v_out jsonb := '{}'::jsonb;
  v_spec record;
  v_prefix_len int;
  v_value text;
  v_end int;
  v_stop int;
  v_decimals int;
BEGIN
  FOREACH v_value IN ARRAY ARRAY[']C1', ']e0', ']d2', ']Q3'] LOOP
    IF left(v_in, 3) = v_value THEN v_in := substring(v_in FROM 4); END IF;
  END LOOP;
  IF left(v_in, 1) = FNC1 THEN v_in := substring(v_in FROM 2); END IF;
  IF v_in ~ '^\(\d{2,4}\)' THEN
    v_in := replace(replace(v_in, '(', ''), ')', '');
  END IF;
  v_in := upper(btrim(v_in));

  IF length(v_in) < 4 THEN RETURN NULL; END IF;

  WHILE v_cursor <= length(v_in) LOOP
    -- A fixed-length field may still be followed by a separator; skip it.
    WHILE substring(v_in FROM v_cursor FOR 1) = FNC1 LOOP
      v_cursor := v_cursor + 1;
    END LOOP;
    EXIT WHEN v_cursor > length(v_in);

    v_spec := NULL;
    v_decimals := NULL;

    SELECT t.* INTO v_spec FROM public.gs1_ai_table() t
     WHERE t.decimal_indicator
       AND t.ai = substring(v_in FROM v_cursor FOR 3)
       AND substring(v_in FROM v_cursor + 3 FOR 1) ~ '^[0-9]$'
     LIMIT 1;
    IF v_spec.ai IS NOT NULL THEN
      v_prefix_len := 4;
      v_decimals := substring(v_in FROM v_cursor + 3 FOR 1)::int;
    ELSE
      SELECT t.* INTO v_spec FROM public.gs1_ai_table() t
       WHERE NOT t.decimal_indicator AND t.ai = substring(v_in FROM v_cursor FOR 3) LIMIT 1;
      IF v_spec.ai IS NOT NULL THEN
        v_prefix_len := 3;
      ELSE
        SELECT t.* INTO v_spec FROM public.gs1_ai_table() t
         WHERE NOT t.decimal_indicator AND t.ai = substring(v_in FROM v_cursor FOR 2) LIMIT 1;
        v_prefix_len := 2;
      END IF;
    END IF;

    IF v_spec.ai IS NULL THEN
      IF v_out = '{}'::jsonb THEN RETURN NULL; END IF;
      EXIT;
    END IF;

    v_cursor := v_cursor + v_prefix_len;

    IF v_spec.fixed IS NOT NULL THEN
      v_value := substring(v_in FROM v_cursor FOR v_spec.fixed);
      IF length(v_value) < v_spec.fixed THEN
        IF v_out = '{}'::jsonb THEN RETURN NULL; END IF;
        EXIT;
      END IF;
      v_cursor := v_cursor + v_spec.fixed;
    ELSE
      v_end := position(FNC1 IN substring(v_in FROM v_cursor));
      IF v_end = 0 THEN
        v_stop := least(length(v_in) + 1, v_cursor + coalesce(v_spec.max_len, 48));
        v_value := substring(v_in FROM v_cursor FOR v_stop - v_cursor);
        v_cursor := v_stop;
      ELSE
        v_value := substring(v_in FROM v_cursor FOR v_end - 1);
        v_cursor := v_cursor + v_end;
      END IF;
    END IF;

    v_out := v_out || jsonb_build_object(v_spec.name, v_value);
    IF v_decimals IS NOT NULL THEN
      v_out := v_out || jsonb_build_object(
        '_' || v_spec.name, (v_value::numeric / power(10, v_decimals)));
    END IF;
  END LOOP;

  IF v_out = '{}'::jsonb THEN RETURN NULL; END IF;
  RETURN v_out;
END $$;
