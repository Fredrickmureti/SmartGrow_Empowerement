/**
 * AssetEditPage — full-page /:id/edit route replacement for
 * `AssetFormSheet` in edit mode. Route: `/finance/fixed-assets/:id/edit`.
 */
import { useEffect, useState, type FormEvent } from "react";
import { useNavigate, useParams } from "react-router-dom";

import {
  ErrorState,
  LoadingState,
  RecordFormShell,
  useRecordFormSubmit,
} from "@/design-system";
import { useFixedAssets, type FixedAsset } from "@/hooks/useFixedAssets";
import { useBusinessCurrencies } from "@/hooks/useBusinessCurrencies";
import { describeAssetCurrencyError } from "./assetCurrencyError";
import { AssetFormBody, emptyAssetForm, type AssetFormValues } from "./AssetFormBody";

export default function AssetEditPage() {
  const { id: assetId = "" } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const { assets, categories, updateAsset } = useFixedAssets();
  const { currencyCodes, baseCurrency } = useBusinessCurrencies();

  const asset = assets.find((a) => a.id === assetId) || null;
  const [values, setValues] = useState<AssetFormValues>(emptyAssetForm);
  const [hydrated, setHydrated] = useState(false);

  // The acquisition measurement is frozen once the asset has been depreciated
  // or disposed — the database refuses the change, so the form disables it.
  const acquisitionLocked =
    !!asset &&
    (Number(asset.accumulated_depreciation ?? 0) > 0 || asset.status === "disposed");

  useEffect(() => {
    if (!asset || hydrated) return;
    setValues({
      name: asset.name,
      description: asset.description || "",
      category_id: asset.category_id || "",
      purchase_date: asset.purchase_date,
      purchase_price: asset.purchase_price,
      currency: asset.currency || baseCurrency,
      residual_value: asset.residual_value || 0,
      useful_life_years: asset.useful_life_years || 5,
      depreciation_method: asset.depreciation_method || "straight_line",
      serial_number: asset.serial_number || "",
      location: asset.location || "",
      vendor_id: asset.vendor_id || "",
    });
    setHydrated(true);
  }, [asset, hydrated, baseCurrency]);

  const submit = useRecordFormSubmit<FixedAsset | void>({
    entityLabel: "Asset",
    mode: "edit",
    redirectTo: () => `/finance/fixed-assets?peek=${assetId}`,
  });

  const onSubmit = (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    if (!asset) return;
    submit.run(async () => {
      try {
        return await updateAsset(asset.id, {
          name: values.name,
          description: values.description || null,
          category_id: values.category_id || null,
          serial_number: values.serial_number || null,
          location: values.location || null,
          vendor_id: values.vendor_id || null,
          useful_life_years: values.useful_life_years,
          depreciation_method: values.depreciation_method,
          // The acquisition measurement is only sent while it is still open.
          // A rate is never sent: re-stamping happens server-side when the
          // currency or the purchase date changes.
          ...(acquisitionLocked
            ? {}
            : {
                purchase_date: values.purchase_date,
                purchase_price: values.purchase_price,
                currency: values.currency || baseCurrency,
                residual_value: values.residual_value,
              }),
        } as any);
      } catch (err) {
        throw describeAssetCurrencyError(err);
      }
    });
  };

  if (!asset) {
    return assets.length === 0 ? (
      <LoadingState />
    ) : (
      <ErrorState
        title="Asset not found"
        description="This asset may have been deleted or you don't have access."
        onRetry={() => navigate("/finance/fixed-assets")}
      />
    );
  }

  return (
    <RecordFormShell
      mode="edit"
      entityLabel="Asset"
      recordRef={asset.asset_number}
      cancelHref={`/finance/fixed-assets?peek=${assetId}`}
      onSubmit={onSubmit}
      isSubmitting={submit.isSubmitting}
      submitDisabled={!values.name || values.purchase_price <= 0}
    >
      <AssetFormBody
        values={values}
        onChange={setValues}
        categories={categories}
        currencyOptions={currencyCodes}
        baseCurrency={baseCurrency}
        acquisitionLocked={acquisitionLocked}
        acquisitionLockReason={
          acquisitionLocked
            ? `Acquisition currency, date and cost are frozen: this asset has been ${
                asset.status === "disposed" ? "disposed" : "depreciated"
              }. Recorded at ${asset.currency} ${asset.purchase_price} @ ${asset.acquisition_exchange_rate}.`
            : undefined
        }
      />
    </RecordFormShell>
  );
}
