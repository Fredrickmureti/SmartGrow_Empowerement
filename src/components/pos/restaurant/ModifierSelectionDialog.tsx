/**
 * Modifier Selection Component
 * 
 * UI for selecting modifiers when adding a product to cart.
 */

import { useState, useEffect } from "react";
import { useModifiers, ModifierGroup, SelectedModifier } from "@/hooks/pos/useModifiers";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from "@/components/ui/dialog";
import { Checkbox } from "@/components/ui/checkbox";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { ScrollArea } from "@/components/ui/scroll-area";
import { AlertCircle, Plus, Minus } from "lucide-react";
import { useCurrency } from "@/hooks/useCurrency";

interface ModifierSelectionDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  productId: string;
  productName: string;
  basePrice: number;
  onConfirm: (modifiers: SelectedModifier[], totalAdjustment: number) => void;
}

export function ModifierSelectionDialog({
  open,
  onOpenChange,
  productId,
  productName,
  basePrice,
  onConfirm,
}: ModifierSelectionDialogProps) {
  const { productModifierGroups, isLoading, validateSelection, calculateModifiersTotal } = useModifiers(productId);
  const { formatCurrency } = useCurrency();
  
  const [selections, setSelections] = useState<Map<string, SelectedModifier[]>>(new Map());
  const [errors, setErrors] = useState<Map<string, string>>(new Map());

  // Reset selections when dialog opens
  useEffect(() => {
    if (open) {
      const initialSelections = new Map<string, SelectedModifier[]>();
      
      // Pre-select default modifiers
      productModifierGroups.forEach(pmg => {
        const group = pmg.modifier_group;
        if (!group) return;
        
        const defaults = group.modifiers?.filter(m => m.is_default && m.is_active) || [];
        if (defaults.length > 0) {
          initialSelections.set(group.id, defaults.map(m => ({
            modifier_id: m.id,
            modifier_name: m.name,
            price_adjustment: m.price_adjustment,
          })));
        }
      });
      
      setSelections(initialSelections);
      setErrors(new Map());
    }
  }, [open, productModifierGroups]);

  const handleToggleModifier = (group: ModifierGroup, modifierId: string, modifierName: string, priceAdjustment: number) => {
    const groupSelections = selections.get(group.id) || [];
    const isSelected = groupSelections.some(s => s.modifier_id === modifierId);
    
    let newGroupSelections: SelectedModifier[];
    
    if (group.selection_type === "single") {
      // Single selection - replace
      newGroupSelections = isSelected 
        ? [] 
        : [{ modifier_id: modifierId, modifier_name: modifierName, price_adjustment: priceAdjustment }];
    } else {
      // Multiple selection - toggle
      if (isSelected) {
        newGroupSelections = groupSelections.filter(s => s.modifier_id !== modifierId);
      } else {
        // Check max selections
        if (group.max_selections && groupSelections.length >= group.max_selections) {
          return; // Don't add more
        }
        newGroupSelections = [...groupSelections, { modifier_id: modifierId, modifier_name: modifierName, price_adjustment: priceAdjustment }];
      }
    }
    
    const newSelections = new Map(selections);
    newSelections.set(group.id, newGroupSelections);
    setSelections(newSelections);
    
    // Clear error for this group
    const newErrors = new Map(errors);
    newErrors.delete(group.id);
    setErrors(newErrors);
  };

  const validateAndConfirm = () => {
    const newErrors = new Map<string, string>();
    
    // Validate all groups
    productModifierGroups.forEach(pmg => {
      const group = pmg.modifier_group;
      if (!group) return;
      
      const groupSelections = selections.get(group.id) || [];
      const validation = validateSelection(group, groupSelections.length);
      
      if (!validation.valid) {
        newErrors.set(group.id, validation.message || "Invalid selection");
      }
    });
    
    if (newErrors.size > 0) {
      setErrors(newErrors);
      return;
    }
    
    // Collect all selected modifiers
    const allModifiers: SelectedModifier[] = [];
    selections.forEach(mods => allModifiers.push(...mods));
    
    const totalAdjustment = calculateModifiersTotal(allModifiers);
    onConfirm(allModifiers, totalAdjustment);
    onOpenChange(false);
  };

  const getAllSelectedModifiers = (): SelectedModifier[] => {
    const all: SelectedModifier[] = [];
    selections.forEach(mods => all.push(...mods));
    return all;
  };

  const totalPrice = basePrice + calculateModifiersTotal(getAllSelectedModifiers());

  if (isLoading) {
    return null;
  }

  // If no modifier groups, just confirm immediately
  if (productModifierGroups.length === 0) {
    if (open) {
      onConfirm([], 0);
      onOpenChange(false);
    }
    return null;
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-[95vw] sm:max-w-md max-h-[90vh] overflow-y-auto p-4 sm:p-6">
        <DialogHeader>
          <DialogTitle>Customize {productName}</DialogTitle>
        </DialogHeader>

        <ScrollArea className="max-h-[400px] pr-4">
          <div className="space-y-6">
            {productModifierGroups.map(pmg => {
              const group = pmg.modifier_group;
              if (!group || !group.modifiers) return null;
              
              const activeModifiers = group.modifiers.filter(m => m.is_active);
              if (activeModifiers.length === 0) return null;
              
              const groupSelections = selections.get(group.id) || [];
              const error = errors.get(group.id);
              
              return (
                <div key={group.id} className="space-y-3">
                  <div className="flex items-center justify-between">
                    <div>
                      <h4 className="font-medium">{group.name}</h4>
                      <p className="text-xs text-muted-foreground">
                        {group.selection_type === "single" ? "Select one" : 
                          group.max_selections ? `Select up to ${group.max_selections}` : "Select any"}
                        {group.is_required && " (required)"}
                      </p>
                    </div>
                    {group.is_required && (
                      <Badge variant="outline" className="text-xs">Required</Badge>
                    )}
                  </div>
                  
                  {error && (
                    <div className="flex items-center gap-2 text-sm text-destructive">
                      <AlertCircle className="h-4 w-4" />
                      {error}
                    </div>
                  )}
                  
                  <div className="space-y-2">
                    {group.selection_type === "single" ? (
                      <RadioGroup
                        value={groupSelections[0]?.modifier_id || ""}
                        onValueChange={(value) => {
                          const mod = activeModifiers.find(m => m.id === value);
                          if (mod) {
                            handleToggleModifier(group, mod.id, mod.name, mod.price_adjustment);
                          }
                        }}
                      >
                        {activeModifiers.map(mod => (
                          <div 
                            key={mod.id}
                            className="flex items-center justify-between p-2 rounded-lg hover:bg-accent"
                          >
                            <div className="flex items-center gap-2">
                              <RadioGroupItem value={mod.id} id={mod.id} />
                              <Label htmlFor={mod.id} className="cursor-pointer">
                                {mod.name}
                              </Label>
                            </div>
                            {mod.price_adjustment !== 0 && (
                              <span className={mod.price_adjustment > 0 ? "text-amber-600" : "text-green-600"}>
                                {mod.price_adjustment > 0 ? "+" : ""}{formatCurrency(Math.abs(mod.price_adjustment))}
                              </span>
                            )}
                          </div>
                        ))}
                      </RadioGroup>
                    ) : (
                      activeModifiers.map(mod => {
                        const isSelected = groupSelections.some(s => s.modifier_id === mod.id);
                        return (
                          <div 
                            key={mod.id}
                            className="flex items-center justify-between p-2 rounded-lg hover:bg-accent cursor-pointer"
                            onClick={() => handleToggleModifier(group, mod.id, mod.name, mod.price_adjustment)}
                          >
                            <div className="flex items-center gap-2">
                              <Checkbox checked={isSelected} />
                              <span>{mod.name}</span>
                            </div>
                            {mod.price_adjustment !== 0 && (
                            <span className={mod.price_adjustment > 0 ? "text-amber-600" : "text-green-600"}>
                              {mod.price_adjustment > 0 ? "+" : ""}{formatCurrency(Math.abs(mod.price_adjustment))}
                              </span>
                            )}
                          </div>
                        );
                      })
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        </ScrollArea>

        <DialogFooter className="flex-col sm:flex-row gap-2">
          <div className="flex-1 text-left">
            <span className="text-muted-foreground">Total: </span>
            <span className="text-xl font-bold">{formatCurrency(totalPrice)}</span>
          </div>
          <div className="flex gap-2">
            <Button variant="outline" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button onClick={validateAndConfirm}>
              Add to Order
            </Button>
          </div>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
