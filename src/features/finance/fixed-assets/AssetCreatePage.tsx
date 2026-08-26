/**
 * AssetCreatePage — full-page /new route replacement for `AssetFormSheet`
 * in create mode. Route: `/finance/fixed-assets/new`.
 */
import { useEffect, useState, type FormEvent } from "react";

import { RecordFormShell, useRecordFormSubmit } from "@/design-system";
import { useFixedAssets, type FixedAsset } from "@/hooks/useFixedAssets";
import { useBusinessCurrencies } from "@/hooks/useBusinessCurrencies";
import { describeAssetCurrencyError } from "./assetCurrencyError";
import { AssetFormBody, emptyAssetForm } from "./AssetFormBody";

export default function AssetCreatePage() {
  const { categories, createAsset } = useFixedAssets();
  const { currencyCodes, baseCurrency } = useBusinessCurrencies();
  const [values, setValues] = useState(emptyAssetForm);

  // Default to the company base currency once the enabled list has resolved.
  useEffect(() => {
    if (!values.currency && baseCurrency) {
      setValues((prev) => (prev.currency ? prev : { ...prev, currency: baseCurrency }));
    }
  }, [baseCurrency, values.currency]);

  const submit = useRecordFormSubmit<FixedAsset | void>({
    entityLabel: "Asset",
    mode: "create",
    redirectTo: () => "/finance/fixed-assets",
  });

  const onSubmit = (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    submit.run(async () => {
      try {
        return await createAsset({
          name: values.name,
          description: values.description || null,
          category_id: values.category_id || null,
          purchase_date: values.purchase_date,
          purchase_price: values.purchase_price,
          // Transaction currency only. The acquisition rate and the base cost
          // are stamped server-side; the client never supplies a rate.
          currency: values.currency || baseCurrency,
          residual_value: values.residual_value,
          useful_life_years: values.useful_life_years,
          depreciation_method: values.depreciation_method,
          serial_number: values.serial_number || null,
          location: values.location || null,
          vendor_id: values.vendor_id || null,
          invoice_reference: null,
          branch_id: null,
          assigned_to: null,
          depreciation_start_date: null,
          accumulated_depreciation: 0,
          book_value: values.purchase_price,
          status: "active",
          disposal_date: null,
          disposal_price: null,
          disposal_reason: null,
          barcode: null,
          insurance_value: null,
          insurance_policy: null,
          insurance_expiry: null,
          warranty_expiry: null,
          notes: null,
        } as any);
      } catch (err) {
        throw describeAssetCurrencyError(err);
      }
    });
  };

  return (
    <RecordFormShell
      mode="create"
      entityLabel="Asset"
      cancelHref="/finance/fixed-assets"
      onSubmit={onSubmit}
      isSubmitting={submit.isSubmitting}
      submitDisabled={
        !values.name || values.purchase_price <= 0 || !(values.currency || baseCurrency)
      }
    >
      <AssetFormBody
        values={values}
        onChange={setValues}
        categories={categories}
        currencyOptions={currencyCodes}
        baseCurrency={baseCurrency}
      />
    </RecordFormShell>
  );
}
