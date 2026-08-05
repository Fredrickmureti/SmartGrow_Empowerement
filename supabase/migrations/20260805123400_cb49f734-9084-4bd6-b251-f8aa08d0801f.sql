REVOKE ALL ON FUNCTION public.enroll_product_barcode(uuid, uuid, text, public.product_identifier_kind, uuid) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.revoke_product_barcode(uuid, uuid, text) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.product_identification_queue(uuid, text, integer, integer) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.flag_product_for_review(uuid, uuid, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.enroll_product_barcode(uuid, uuid, text, public.product_identifier_kind, uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.revoke_product_barcode(uuid, uuid, text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.product_identification_queue(uuid, text, integer, integer) TO authenticated;
GRANT EXECUTE ON FUNCTION public.flag_product_for_review(uuid, uuid, text) TO authenticated;