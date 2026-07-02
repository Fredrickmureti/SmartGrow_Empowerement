CREATE POLICY "Vendor portal users can delete their vendor items"
ON rfq_vendor_items FOR DELETE
USING (rfq_vendor_id IN (
  SELECT rv.id FROM rfq_vendors rv
  WHERE rv.vendor_id IN (
    SELECT c.id FROM contacts c WHERE c.portal_user_id = auth.uid()
  )
));