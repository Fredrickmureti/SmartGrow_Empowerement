-- Remove decorative em-dash fallbacks from the ANNUAL_EARNINGS_STATEMENT
-- base template so genuinely-missing optional fields are omitted (not
-- rendered as "—"). The compiler now elides key_value rows whose binding
-- resolves to empty AND has no explicit fallback. `content_hash_short`
-- is always written by the resolver — dropping its fallback turns a
-- missing hash into a visible bug rather than a designed placeholder.
UPDATE public.localization_pack_certificate_templates
SET body = jsonb_set(
  body,
  '{document}',
  (
    SELECT jsonb_agg(
      CASE
        WHEN node->>'type' = 'identity_strip' THEN
          jsonb_set(
            jsonb_set(node, '{left}',
              (SELECT jsonb_agg(
                 CASE
                   WHEN (kv->'value'->>'kind') = 'binding'
                        AND (kv->'value'->>'fallback') = '—'
                     THEN jsonb_set(kv, '{value}', (kv->'value') - 'fallback')
                   ELSE kv
                 END)
               FROM jsonb_array_elements(node->'left') AS kv)),
            '{right}',
            (SELECT jsonb_agg(
               CASE
                 WHEN (kv->'value'->>'kind') = 'binding'
                      AND (kv->'value'->>'fallback') = '—'
                   THEN jsonb_set(kv, '{value}', (kv->'value') - 'fallback')
                 ELSE kv
               END)
             FROM jsonb_array_elements(node->'right') AS kv))
        ELSE node
      END
    )
    FROM jsonb_array_elements(body->'document') AS node
  )
)
WHERE code = 'ANNUAL_EARNINGS_STATEMENT' AND pack_id IS NULL;

-- Strip the "—" fallback from the footer content_hash_short binding.
UPDATE public.localization_pack_certificate_templates
SET body = jsonb_set(
  body,
  '{page_master,footer}',
  (
    SELECT jsonb_agg(
      CASE
        WHEN fn->>'type' = 'rich_text' THEN
          jsonb_set(fn, '{paragraphs}',
            (SELECT jsonb_agg(
               (SELECT jsonb_agg(
                  CASE
                    WHEN (run->'text'->>'kind') = 'binding'
                         AND (run->'text'->>'path') = 'provenance.content_hash_short'
                         AND (run->'text'->>'fallback') = '—'
                      THEN jsonb_set(run, '{text}', (run->'text') - 'fallback')
                    ELSE run
                  END)
                FROM jsonb_array_elements(para) AS run))
             FROM jsonb_array_elements(fn->'paragraphs') AS para))
        ELSE fn
      END
    )
    FROM jsonb_array_elements(body->'page_master'->'footer') AS fn
  )
)
WHERE code = 'ANNUAL_EARNINGS_STATEMENT' AND pack_id IS NULL;