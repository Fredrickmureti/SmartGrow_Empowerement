import { supabase } from "@/integrations/supabase/client";

export interface MOQResult {
  isValid: boolean;
  minQuantity: number;
  increment: number;
  adjustedQuantity: number;
  message?: string;
}

export function useMOQValidation() {
  /**
   * Validate if a quantity meets MOQ requirements
   */
  const validateOrderQuantity = async (
    productId: string,
    quantity: number
  ): Promise<MOQResult> => {
    const { data: product, error } = await supabase
      .from("products")
      .select("min_order_quantity, order_quantity_increment, name")
      .eq("id", productId)
      .single();

    if (error || !product) {
      return {
        isValid: true,
        minQuantity: 1,
        increment: 1,
        adjustedQuantity: quantity,
      };
    }

    const minQty = product.min_order_quantity || 1;
    const increment = product.order_quantity_increment || 1;

    // Check minimum order quantity
    if (quantity < minQty) {
      return {
        isValid: false,
        minQuantity: minQty,
        increment,
        adjustedQuantity: minQty,
        message: `Minimum order quantity for ${product.name} is ${minQty}`,
      };
    }

    // Check if quantity is valid increment
    const remainder = (quantity - minQty) % increment;
    if (remainder !== 0) {
      const adjustedQty = quantity + (increment - remainder);
      return {
        isValid: false,
        minQuantity: minQty,
        increment,
        adjustedQuantity: adjustedQty,
        message: `${product.name} must be ordered in increments of ${increment}. Adjusted to ${adjustedQty}`,
      };
    }

    return {
      isValid: true,
      minQuantity: minQty,
      increment,
      adjustedQuantity: quantity,
    };
  };

  /**
   * Get the increment value for a product (for quantity steppers)
   */
  const getOrderQuantityIncrement = async (productId: string): Promise<number> => {
    const { data: product } = await supabase
      .from("products")
      .select("order_quantity_increment")
      .eq("id", productId)
      .single();

    return product?.order_quantity_increment || 1;
  };

  /**
   * Adjust quantity to the nearest valid value
   */
  const adjustToValidQuantity = async (
    productId: string,
    quantity: number
  ): Promise<number> => {
    const result = await validateOrderQuantity(productId, quantity);
    return result.adjustedQuantity;
  };

  /**
   * Validate multiple items at once
   */
  const validateOrderItems = async (
    items: Array<{ productId: string; quantity: number }>
  ): Promise<{ isValid: boolean; errors: MOQResult[] }> => {
    const results = await Promise.all(
      items.map(async (item) => {
        const result = await validateOrderQuantity(item.productId, item.quantity);
        return { ...result, productId: item.productId };
      })
    );

    const errors = results.filter((r) => !r.isValid);
    return {
      isValid: errors.length === 0,
      errors,
    };
  };

  return {
    validateOrderQuantity,
    getOrderQuantityIncrement,
    adjustToValidQuantity,
    validateOrderItems,
  };
}
