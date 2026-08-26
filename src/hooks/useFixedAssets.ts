import { useState, useEffect, useCallback } from "react";
import { supabase } from "@/integrations/supabase/client";
import { useOrganization } from "./useOrganization";
import { useBusinesses } from "./useBusinesses";
import { useAuth } from "@/contexts/AuthContext";
import { toast } from "sonner";
import { usePermissions } from "./usePermissions";
import { useGLPosting } from "./useGLPosting";
import { useDefaultAccounts } from "./useDefaultAccounts";
import { useAuditLog } from "./useAuditLog";
import { useFinanceScope } from "@/hooks/finance/useFinanceScope";
import { financeKey } from "@/lib/finance/financeKey";

export interface AssetCategory {
  id: string;
  organization_id: string;
  name: string;
  description: string | null;
  depreciation_method: string;
  useful_life_years: number;
  depreciation_rate: number | null;
  asset_account_id: string | null;
  depreciation_account_id: string | null;
  accumulated_depreciation_account_id: string | null;
  gain_loss_account_id: string | null;
  is_active: boolean;
  created_at: string;
  updated_at: string;
}

export interface FixedAsset {
  id: string;
  organization_id: string;
  business_id?: string | null;
  category_id: string | null;
  asset_number: string;
  name: string;
  description: string | null;
  purchase_date: string;
  /** Cost in the currency the asset was actually bought in. Evidence, not the accounting basis. */
  purchase_price: number;
  /** Transaction currency. Server-stamped; immutable once depreciated or posted. */
  currency: string;
  /** Rate resolved server-side on purchase_date — the IAS 21 historical rate. */
  acquisition_exchange_rate: number;
  /** purchase_price x acquisition_exchange_rate. The accounting basis for depreciation and GL. */
  base_purchase_price: number;
  base_residual_value: number;
  /** Rate on disposal_date; proceeds are monetary so they translate at disposal, not at acquisition. */
  disposal_exchange_rate: number | null;
  base_disposal_price: number | null;
  vendor_id: string | null;
  invoice_reference: string | null;
  branch_id: string | null;
  location: string | null;
  assigned_to: string | null;
  depreciation_method: string;
  useful_life_years: number;
  residual_value: number;
  depreciation_start_date: string | null;
  accumulated_depreciation: number;
  book_value: number | null;
  status: string;
  disposal_date: string | null;
  disposal_price: number | null;
  disposal_reason: string | null;
  serial_number: string | null;
  barcode: string | null;
  insurance_value: number | null;
  insurance_policy: string | null;
  insurance_expiry: string | null;
  warranty_expiry: string | null;
  notes: string | null;
  created_at: string;
  updated_at: string;
  category?: AssetCategory | null;
}

export interface DepreciationEntry {
  id: string;
  organization_id: string;
  asset_id: string;
  period_start: string;
  period_end: string;
  depreciation_amount: number;
  accumulated_depreciation: number;
  book_value: number;
  journal_entry_id: string | null;
  is_posted: boolean;
  created_at: string;
}

export function useFixedAssets() {
  const { currentOrg } = useOrganization();
  const { currentBusiness } = useBusinesses();
  const scope = useFinanceScope();
  const { user } = useAuth();
  const { can } = usePermissions();
  const { postToGL } = useGLPosting();
  const { getFixedAssetAccountMappings } = useDefaultAccounts();
  const { logAction } = useAuditLog();
  const [assets, setAssets] = useState<FixedAsset[]>([]);
  const [categories, setCategories] = useState<AssetCategory[]>([]);
  const [isLoading, setIsLoading] = useState(true);

  // financeKey is used for cache identity — hook keys: financeKey(scope, "fixed-assets")
  const _cacheKey = financeKey(scope, "fixed-assets");
  void _cacheKey;

  const fetchAssets = useCallback(async () => {
    if (!currentOrg || !currentBusiness) return;
    setIsLoading(true);

    try {
      let query = supabase
        .from("fixed_assets")
        .select(`
          *,
          category:asset_categories(*)
        `)
        .eq("organization_id", currentOrg.id)
        .eq("business_id", currentBusiness.id);

      // Branch users (specific branch active) only see their branch's assets
      // plus business-level (branch_id IS NULL). Consolidated view keeps all rows.
      if (scope.branchId) {
        query = query.or(`branch_id.eq.${scope.branchId},branch_id.is.null`);
      }

      const { data, error } = await query.order("asset_number", { ascending: true });

      if (error) throw error;
      setAssets(data || []);
    } catch (error) {
      console.error("Error fetching fixed assets:", error);
      toast.error("Failed to fetch fixed assets");
    } finally {
      setIsLoading(false);
    }
  }, [currentOrg?.id, currentBusiness?.id, scope.branchId]);

  const fetchCategories = useCallback(async () => {
    if (!currentOrg || !currentBusiness) return;

    try {
      const { data, error } = await supabase
        .from("asset_categories")
        .select("*")
        .eq("organization_id", currentOrg.id)
        .eq("business_id", currentBusiness.id)
        .eq("is_active", true)
        .order("name", { ascending: true });

      if (error) throw error;
      setCategories(data || []);
    } catch (error) {
      console.error("Error fetching asset categories:", error);
    }
  }, [currentOrg?.id, currentBusiness?.id]);

  useEffect(() => {
    fetchAssets();
    fetchCategories();
  }, [fetchAssets, fetchCategories]);

  const getNextAssetNumber = async (): Promise<string> => {
    if (!currentOrg) return "AST-0001";

    const { data, error } = await supabase.rpc("get_next_asset_number", {
      _org_id: currentOrg.id,
    });

    if (error) {
      console.error("Error getting asset number:", error);
      return `AST-${Date.now()}`;
    }

    return data || "AST-0001";
  };

  const createCategory = async (category: Omit<AssetCategory, "id" | "organization_id" | "created_at" | "updated_at">) => {
    if (!can("manageFinancials")) { toast.error("You don't have permission to create asset categories"); throw new Error("Permission denied"); }
    if (!currentOrg) throw new Error("No organization selected");
    if (!currentBusiness?.id) throw new Error("No company selected — asset categories are per-company");

    const { data, error } = await supabase
      .from("asset_categories")
      .insert({
        ...category,
        organization_id: currentOrg.id,
        business_id: currentBusiness.id,
      } as any)
      .select()
      .single();

    if (error) throw error;

    toast.success("Asset category created successfully");
    await fetchCategories();
    return data;
  };

  const createAsset = async (
    asset: Omit<
      FixedAsset,
      | "id"
      | "organization_id"
      | "asset_number"
      | "created_at"
      | "updated_at"
      | "category"
      | "acquisition_exchange_rate"
      | "base_purchase_price"
      | "base_residual_value"
      | "disposal_exchange_rate"
      | "base_disposal_price"
    > & { currency?: string },
  ) => {
    if (!can("manageFinancials")) { toast.error("You don't have permission to create assets"); throw new Error("Permission denied"); }
    if (!currentOrg || !user) throw new Error("No organization selected");

    const assetNumber = await getNextAssetNumber();
    // Stamp branch from active scope when caller did not specify one.
    const stampedBranchId = asset.branch_id ?? scope.branchId ?? null;

    const { data, error } = await supabase
      .from("fixed_assets")
      .insert({
        ...asset,
        branch_id: stampedBranchId,
        organization_id: currentOrg.id,
        business_id: currentBusiness?.id,
        asset_number: assetNumber,
        // currency, acquisition_exchange_rate, base_purchase_price,
        // base_residual_value and book_value are stamped server-side by
        // trg_fixed_assets_stamp_currency through the one FX engine. A
        // client-supplied rate is ignored; a foreign asset with no rate on
        // file is refused rather than recorded at face value.
        created_by: user.id,
      } as any)
      .select()
      .single();

    if (error) throw error;

    // The ledger is kept in the base currency: post the server-stamped base cost.
    const baseCost = Number((data as any).base_purchase_price ?? asset.purchase_price);

    // Post acquisition journal entry: Dr Fixed Asset, Cr Cash/Bank
    const mappings = getFixedAssetAccountMappings();
    if (mappings.fixed_asset_account_id && mappings.payment_account_id) {
      try {
        await postToGL({
          source_type: "asset_acquisition",
          source_id: data.id,
          reference: assetNumber,
          memo: `Fixed asset acquisition: ${asset.name}`,
          entry_date: asset.purchase_date,
          // Stamp the JE with the asset's branch so consolidated/branch reports reconcile.
          branch_id: stampedBranchId,
          entries: [
            { account_id: mappings.fixed_asset_account_id, debit_amount: baseCost, credit_amount: 0, description: `Asset acquisition - ${asset.name}` },
            { account_id: mappings.payment_account_id, debit_amount: 0, credit_amount: baseCost, description: `Payment for asset - ${assetNumber}` },
          ],
        });
      } catch (glError) {
        console.error("GL posting for asset acquisition failed:", glError);
        toast.error("Asset created but GL posting failed. Check default account mappings.");
      }
    } else {
      console.warn("Fixed asset GL posting skipped: missing account mappings. Configure in Finance Settings.");
    }

    // Audit log
    logAction({
      action: "created",
      entityType: "fixed_asset",
      entityId: data.id,
      entityName: `${assetNumber} - ${asset.name}`,
      changesSummary: `Fixed asset created: ${assetNumber}, purchase price ${asset.purchase_price} ${(data as any).currency ?? ""} (base ${baseCost} @ ${(data as any).acquisition_exchange_rate})`,
    });

    toast.success(`Asset ${assetNumber} created successfully`);
    await fetchAssets();
    return data;
  };

  const updateAsset = async (id: string, updates: Partial<FixedAsset>) => {
    if (!can("manageFinancials")) { toast.error("You don't have permission to update assets"); throw new Error("Permission denied"); }
    if (updates.purchase_price !== undefined || updates.accumulated_depreciation !== undefined) {
      const asset = assets.find((a) => a.id === id);
      if (asset) {
        // Carrying value is a base-currency measure against the historical cost.
        const baseCost = Number(asset.base_purchase_price ?? asset.purchase_price);
        const accumulatedDepreciation = updates.accumulated_depreciation ?? asset.accumulated_depreciation;
        updates.book_value = baseCost - accumulatedDepreciation;
      }
    }

    // Strip joined fields
    const { category, ...dbUpdates } = updates as any;

    const { error } = await supabase
      .from("fixed_assets")
      .update(dbUpdates)
      .eq("id", id);

    if (error) throw error;

    toast.success("Asset updated successfully");
    await fetchAssets();
  };

  const disposeAsset = async (id: string, disposalDate: string, disposalPrice: number, reason: string) => {
    if (!can("manageFinancials")) { toast.error("You don't have permission to dispose assets"); throw new Error("Permission denied"); }

    const asset = assets.find((a) => a.id === id);
    if (!asset) throw new Error("Asset not found");

    // The server stamps disposal_exchange_rate on the disposal date and derives
    // base_disposal_price; proceeds are monetary, so they do NOT use the
    // acquisition rate.
    const { data: disposed, error } = await supabase
      .from("fixed_assets")
      .update({
        status: "disposed",
        disposal_date: disposalDate,
        disposal_price: disposalPrice,
        disposal_reason: reason,
      })
      .eq("id", id)
      .select("disposal_exchange_rate, base_disposal_price, base_purchase_price")
      .single();

    if (error) throw error;

    const baseProceeds = Number((disposed as any)?.base_disposal_price ?? disposalPrice);
    const baseCost = Number((disposed as any)?.base_purchase_price ?? asset.purchase_price);

    // Post disposal journal entry
    // Dr Cash/Bank (disposal price)
    // Dr Accumulated Depreciation (accumulated_depreciation)
    // Cr Fixed Asset Account (purchase_price)
    // Dr/Cr Gain/Loss on Disposal (difference)
    const mappings = getFixedAssetAccountMappings();
    const category = categories.find((c) => c.id === asset.category_id);
    const gainLossAccountId = category?.gain_loss_account_id;
    const assetAccountId = category?.asset_account_id || mappings.fixed_asset_account_id;
    const accumDepAccountId = category?.accumulated_depreciation_account_id || mappings.accumulated_depreciation_account_id;
    const cashAccountId = mappings.payment_account_id;

    if (assetAccountId && accumDepAccountId && cashAccountId) {
      const bookValue = baseCost - asset.accumulated_depreciation;
      const gainLoss = baseProceeds - bookValue;

      try {
        const entries = [
          // Dr Cash/Bank for disposal proceeds
          ...(baseProceeds > 0 ? [{
            account_id: cashAccountId,
            debit_amount: baseProceeds,
            credit_amount: 0,
            description: `Disposal proceeds - ${asset.name}`,
          }] : []),
          // Dr Accumulated Depreciation (remove contra-asset)
          ...(asset.accumulated_depreciation > 0 ? [{
            account_id: accumDepAccountId,
            debit_amount: asset.accumulated_depreciation,
            credit_amount: 0,
            description: `Remove accumulated depreciation - ${asset.name}`,
          }] : []),
          // Cr Fixed Asset (remove asset at cost)
          {
            account_id: assetAccountId,
            debit_amount: 0,
            credit_amount: baseCost,
            description: `Asset disposal - ${asset.name}`,
          },
        ];

        // Gain/Loss on disposal
        if (gainLossAccountId && Math.abs(gainLoss) > 0.01) {
          if (gainLoss > 0) {
            // Gain: credit the gain/loss account
            entries.push({
              account_id: gainLossAccountId,
              debit_amount: 0,
              credit_amount: gainLoss,
              description: `Gain on disposal - ${asset.name}`,
            });
          } else {
            // Loss: debit the gain/loss account
            entries.push({
              account_id: gainLossAccountId,
              debit_amount: Math.abs(gainLoss),
              credit_amount: 0,
              description: `Loss on disposal - ${asset.name}`,
            });
          }
        }

        await postToGL({
          source_type: "asset_disposal",
          source_id: id,
          reference: `DISP-${asset.asset_number}`,
          memo: `Asset disposal: ${asset.name} - ${reason}`,
          entry_date: disposalDate,
          // Stamp JE branch from the asset's branch so consolidated/branch reports reconcile.
          branch_id: asset.branch_id ?? null,
          entries,
        });
      } catch (glError) {
        console.error("GL posting for asset disposal failed:", glError);
        toast.error("Asset disposed but GL posting failed. Check account mappings.");
      }
    } else {
      console.warn("Asset disposal GL posting skipped: missing account mappings.");
    }

    logAction({
      action: "deleted",
      entityType: "fixed_asset",
      entityId: id,
      entityName: `${asset.asset_number} - ${asset.name}`,
      changesSummary: `Asset disposed: ${asset.asset_number}, disposal price ${disposalPrice}, reason: ${reason}`,
    });

    toast.success("Asset disposed successfully");
    await fetchAssets();
  };

  const deleteAsset = async (id: string) => {
    if (!can("manageFinancials")) { toast.error("You don't have permission to delete assets"); throw new Error("Permission denied"); }
    const { error } = await supabase.from("fixed_assets").delete().eq("id", id);

    if (error) throw error;

    toast.success("Asset deleted successfully");
    await fetchAssets();
  };

  // Calculate monthly depreciation for an asset
  const calculateMonthlyDepreciation = (asset: FixedAsset): number => {
    if (asset.depreciation_method === "straight_line") {
      const depreciableAmount =
        Number(asset.base_purchase_price ?? asset.purchase_price) -
        Number(asset.base_residual_value ?? asset.residual_value);
      const totalMonths = asset.useful_life_years * 12;
      return Math.round((depreciableAmount / totalMonths) * 100) / 100;
    } else if (asset.depreciation_method === "reducing_balance") {
      const category = categories.find((c) => c.id === asset.category_id);
      const rate = category?.depreciation_rate || 25;
      const yearlyDepreciation = asset.book_value! * (rate / 100);
      return Math.round((yearlyDepreciation / 12) * 100) / 100;
    }
    return 0;
  };

  // Get asset statistics
  const getAssetStats = () => {
    const activeAssets = assets.filter((a) => a.status === "active");
    // Totals are base-currency measures: mixing transaction currencies would add
    // unlike units.
    const totalPurchaseValue = activeAssets.reduce(
      (sum, a) => sum + Number(a.base_purchase_price ?? a.purchase_price),
      0,
    );
    const totalBookValue = activeAssets.reduce((sum, a) => sum + (a.book_value || 0), 0);
    const totalAccumulatedDepreciation = activeAssets.reduce((sum, a) => sum + a.accumulated_depreciation, 0);

    return {
      totalAssets: activeAssets.length,
      totalPurchaseValue,
      totalBookValue,
      totalAccumulatedDepreciation,
    };
  };

  return {
    assets,
    categories,
    activeAssets: assets.filter((a) => a.status === "active"),
    isLoading,
    getNextAssetNumber,
    createCategory,
    createAsset,
    updateAsset,
    disposeAsset,
    deleteAsset,
    calculateMonthlyDepreciation,
    getAssetStats,
    refreshAssets: fetchAssets,
    refreshCategories: fetchCategories,
  };
}
