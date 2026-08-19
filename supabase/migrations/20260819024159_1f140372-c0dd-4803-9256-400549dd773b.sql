CREATE OR REPLACE FUNCTION public.bank_transaction_fingerprint(
  _bank_account_id uuid,
  _txn_date date,
  _description text,
  _amount numeric,
  _reference text
)
RETURNS text
LANGUAGE plpgsql
IMMUTABLE
SET search_path TO 'public'
AS $function$
DECLARE
  raw   text;
  h1    bigint := 2166136261;   -- 0x811c9dc5
  h2    bigint := 16777619;     -- 0x01000193
  i     int;
  cp    int;
  u     int;
  units int[];
  m     bigint := 4294967296;   -- 2^32
BEGIN
  raw := _bank_account_id::text
      || '|' || to_char(_txn_date, 'YYYY-MM-DD')
      || '|' || btrim(COALESCE(_description, ''))
      || '|' || to_char(COALESCE(_amount, 0), 'FM999999999999990.00')
      || '|' || btrim(COALESCE(_reference, ''));

  FOR i IN 1 .. length(raw) LOOP
    cp := ascii(substr(raw, i, 1));

    -- The browser hashes UTF-16 code units (String.charCodeAt). Fold any
    -- astral code point into its surrogate pair so both implementations
    -- consume the identical byte stream.
    IF cp > 65535 THEN
      units := ARRAY[
        55296 + ((cp - 65536) / 1024),
        56320 + ((cp - 65536) % 1024)
      ];
    ELSE
      units := ARRAY[cp];
    END IF;

    FOREACH u IN ARRAY units LOOP
      -- The multiply is performed in numeric: (h # u) can reach 2^32-1 and
      -- 2^32-1 * 2166136261 exceeds the bigint ceiling, which previously
      -- raised 22003 before the modulo could reduce it. The mathematical
      -- result is unchanged.
      h1 := (((h1 # u)::numeric * 16777619)   % m)::bigint;
      h2 := (((h2 # u)::numeric * 2166136261) % m)::bigint;
    END LOOP;
  END LOOP;

  RETURN 'imp_' || lpad(to_hex(h1), 8, '0') || lpad(to_hex(h2), 8, '0');
END;
$function$;