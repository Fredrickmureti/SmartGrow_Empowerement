import { useState, useEffect } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Accordion, AccordionContent, AccordionItem, AccordionTrigger } from "@/components/ui/accordion";
import { 
  Loader2, Type, AlignLeft, DollarSign, FileSignature, Settings2, Wallet
} from "lucide-react";
import { PaymentMethodSelector } from "./PaymentMethodSelector";
import type { 
  DocumentTemplateInput, 
  DocumentTemplateType,
  TotalsPosition,
} from "@/types/documentTemplate";
import { 
  DEFAULT_TEMPLATE, 
  DOCUMENT_TYPE_LABELS 
} from "@/types/documentTemplate";

interface ExtendedTemplateInput extends DocumentTemplateInput {
  payment_method_ids?: string[];
}

interface DocumentTemplateBuilderProps {
  initialTemplate?: Partial<ExtendedTemplateInput>;
  templateType: DocumentTemplateType;
  onSave: (template: ExtendedTemplateInput) => Promise<void>;
  onCancel?: () => void;
  isSaving?: boolean;
}

export function DocumentTemplateBuilder({
  initialTemplate,
  templateType,
  onSave,
  onCancel,
  isSaving = false,
}: DocumentTemplateBuilderProps) {
  const [settings, setSettings] = useState<ExtendedTemplateInput>({
    ...DEFAULT_TEMPLATE,
    template_type: templateType,
    document_title_format: DOCUMENT_TYPE_LABELS[templateType].toUpperCase(),
    ...initialTemplate,
  });
  const [hasChanges, setHasChanges] = useState(false);

  useEffect(() => {
    const changed = JSON.stringify(settings) !== JSON.stringify({
      ...DEFAULT_TEMPLATE,
      template_type: templateType,
      document_title_format: DOCUMENT_TYPE_LABELS[templateType].toUpperCase(),
      ...initialTemplate,
    });
    setHasChanges(changed);
  }, [settings, initialTemplate, templateType]);

  const handleChange = <K extends keyof ExtendedTemplateInput>(
    key: K, 
    value: ExtendedTemplateInput[K]
  ) => {
    setSettings((prev) => ({ ...prev, [key]: value }));
  };

  const handlePaymentMethodsChange = (ids: string[]) => {
    setSettings((prev) => ({ ...prev, payment_method_ids: ids }));
  };

  const handleSave = async () => {
    await onSave(settings);
  };

  return (
    <div className="space-y-4 overflow-auto max-h-[calc(100vh-250px)]">
      {/* Template Details */}
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-base">Template Details</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="grid grid-cols-2 gap-4">
            <div className="space-y-2">
              <Label htmlFor="template-name">Template Name</Label>
              <Input
                id="template-name"
                value={settings.template_name}
                onChange={(e) => handleChange("template_name", e.target.value)}
                placeholder="e.g., Standard Repayment Receipt"
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="document-title">Document Title</Label>
              <Input
                id="document-title"
                value={settings.document_title_format || ''}
                onChange={(e) => handleChange("document_title_format", e.target.value)}
                placeholder="e.g., INVOICE, TAX INVOICE"
              />
            </div>
          </div>
        </CardContent>
      </Card>

      <Accordion type="multiple" defaultValue={["header", "items", "totals", "footer", "advanced"]} className="space-y-2">
        {/* Header Section */}
        <AccordionItem value="header" className="border rounded-lg px-4">
          <AccordionTrigger className="hover:no-underline">
            <div className="flex items-center gap-2">
              <Type className="h-4 w-4" />
              <span>Header Section</span>
            </div>
          </AccordionTrigger>
          <AccordionContent className="space-y-3 pt-2">
            <div className="grid grid-cols-2 gap-3">
              <div className="flex items-center justify-between">
                <Label className="text-sm">Company Name</Label>
                <Switch
                  checked={settings.show_company_name}
                  onCheckedChange={(v) => handleChange("show_company_name", v)}
                />
              </div>
              <div className="flex items-center justify-between">
                <Label className="text-sm">Address</Label>
                <Switch
                  checked={settings.show_company_address}
                  onCheckedChange={(v) => handleChange("show_company_address", v)}
                />
              </div>
              <div className="flex items-center justify-between">
                <Label className="text-sm">Phone</Label>
                <Switch
                  checked={settings.show_company_phone}
                  onCheckedChange={(v) => handleChange("show_company_phone", v)}
                />
              </div>
              <div className="flex items-center justify-between">
                <Label className="text-sm">Email</Label>
                <Switch
                  checked={settings.show_company_email}
                  onCheckedChange={(v) => handleChange("show_company_email", v)}
                />
              </div>
              <div className="flex items-center justify-between">
                <Label className="text-sm">Tax ID</Label>
                <Switch
                  checked={settings.show_tax_id}
                  onCheckedChange={(v) => handleChange("show_tax_id", v)}
                />
              </div>
            </div>
            <div className="space-y-2">
              <Label className="text-sm">Header Text (optional)</Label>
              <Textarea
                value={settings.header_text || ''}
                onChange={(e) => handleChange("header_text", e.target.value || null)}
                placeholder="e.g., Serving you since 1990"
                rows={2}
              />
            </div>
          </AccordionContent>
        </AccordionItem>

        {/* Items Table Section */}
        <AccordionItem value="items" className="border rounded-lg px-4">
          <AccordionTrigger className="hover:no-underline">
            <div className="flex items-center gap-2">
              <AlignLeft className="h-4 w-4" />
              <span>Items Table</span>
            </div>
          </AccordionTrigger>
          <AccordionContent className="space-y-3 pt-2">
            <div className="grid grid-cols-2 gap-3">
              <div className="flex items-center justify-between">
                <Label className="text-sm">Line Numbers</Label>
                <Switch
                  checked={settings.show_line_numbers}
                  onCheckedChange={(v) => handleChange("show_line_numbers", v)}
                />
              </div>
              <div className="flex items-center justify-between">
                <Label className="text-sm">SKU/Code</Label>
                <Switch
                  checked={settings.show_item_sku}
                  onCheckedChange={(v) => handleChange("show_item_sku", v)}
                />
              </div>
              <div className="flex items-center justify-between">
                <Label className="text-sm">Description</Label>
                <Switch
                  checked={settings.show_item_description}
                  onCheckedChange={(v) => handleChange("show_item_description", v)}
                />
              </div>
              <div className="flex items-center justify-between">
                <Label className="text-sm">Unit Price</Label>
                <Switch
                  checked={settings.show_unit_price}
                  onCheckedChange={(v) => handleChange("show_unit_price", v)}
                />
              </div>
              <div className="flex items-center justify-between">
                <Label className="text-sm">Quantity</Label>
                <Switch
                  checked={settings.show_quantity}
                  onCheckedChange={(v) => handleChange("show_quantity", v)}
                />
              </div>
              <div className="flex items-center justify-between">
                <Label className="text-sm">Tax Column</Label>
                <Switch
                  checked={settings.show_tax_column}
                  onCheckedChange={(v) => handleChange("show_tax_column", v)}
                />
              </div>
              <div className="flex items-center justify-between">
                <Label className="text-sm">Discount Column</Label>
                <Switch
                  checked={settings.show_discount_column}
                  onCheckedChange={(v) => handleChange("show_discount_column", v)}
                />
              </div>
            </div>
          </AccordionContent>
        </AccordionItem>

        {/* Totals Section */}
        <AccordionItem value="totals" className="border rounded-lg px-4">
          <AccordionTrigger className="hover:no-underline">
            <div className="flex items-center gap-2">
              <DollarSign className="h-4 w-4" />
              <span>Totals Section</span>
            </div>
          </AccordionTrigger>
          <AccordionContent className="space-y-3 pt-2">
            <div className="grid grid-cols-2 gap-3">
              <div className="flex items-center justify-between">
                <Label className="text-sm">Subtotal</Label>
                <Switch
                  checked={settings.show_subtotal}
                  onCheckedChange={(v) => handleChange("show_subtotal", v)}
                />
              </div>
              <div className="flex items-center justify-between">
                <Label className="text-sm">Discount Total</Label>
                <Switch
                  checked={settings.show_discount_total}
                  onCheckedChange={(v) => handleChange("show_discount_total", v)}
                />
              </div>
              <div className="flex items-center justify-between">
                <Label className="text-sm">Tax Breakdown</Label>
                <Switch
                  checked={settings.show_tax_breakdown}
                  onCheckedChange={(v) => handleChange("show_tax_breakdown", v)}
                />
              </div>
              <div className="flex items-center justify-between">
                <Label className="text-sm">Total in Words</Label>
                <Switch
                  checked={settings.show_total_in_words}
                  onCheckedChange={(v) => handleChange("show_total_in_words", v)}
                />
              </div>
            </div>
            <div className="space-y-2">
              <Label className="text-sm">Totals Position</Label>
              <Select
                value={settings.totals_position}
                onValueChange={(v) => handleChange("totals_position", v as TotalsPosition)}
              >
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="right">Right Aligned</SelectItem>
                  <SelectItem value="center">Center</SelectItem>
                  <SelectItem value="full-width">Full Width</SelectItem>
                </SelectContent>
              </Select>
            </div>
          </AccordionContent>
        </AccordionItem>

        {/* Footer & Payment Section */}
        <AccordionItem value="footer" className="border rounded-lg px-4">
          <AccordionTrigger className="hover:no-underline">
            <div className="flex items-center gap-2">
              <FileSignature className="h-4 w-4" />
              <span>Footer & Payment</span>
            </div>
          </AccordionTrigger>
          <AccordionContent className="space-y-4 pt-2">
            <div className="grid grid-cols-2 gap-3">
              <div className="flex items-center justify-between">
                <Label className="text-sm">Payment Instructions</Label>
                <Switch
                  checked={settings.show_payment_instructions}
                  onCheckedChange={(v) => handleChange("show_payment_instructions", v)}
                />
              </div>
              <div className="flex items-center justify-between">
                <Label className="text-sm">Signature Line</Label>
                <Switch
                  checked={settings.show_signature_line}
                  onCheckedChange={(v) => handleChange("show_signature_line", v)}
                />
              </div>
              <div className="flex items-center justify-between">
                <Label className="text-sm">Terms & Conditions</Label>
                <Switch
                  checked={settings.show_terms}
                  onCheckedChange={(v) => handleChange("show_terms", v)}
                />
              </div>
            </div>

            {settings.show_payment_instructions && (
              <div className="space-y-2">
                <Label className="text-sm">Payment Instructions</Label>
                <Textarea
                  value={settings.payment_instructions || ''}
                  onChange={(e) => handleChange("payment_instructions", e.target.value || null)}
                  placeholder="e.g., Payment due within 30 days. Please include invoice number."
                  rows={2}
                />
              </div>
            )}

            <div className="space-y-3">
              <div className="flex items-center gap-2">
                <Wallet className="h-4 w-4 text-muted-foreground" />
                <Label className="text-sm font-medium">Payment Methods Override</Label>
              </div>
              <p className="text-xs text-muted-foreground">
                Optionally select specific payment methods for this template. Leave empty to show all active methods.
                Payment methods visibility is controlled globally in Settings → Payment Methods.
              </p>
              <PaymentMethodSelector
                selectedIds={settings.payment_method_ids || []}
                onSelectionChange={handlePaymentMethodsChange}
              />
            </div>

            {settings.show_signature_line && (
              <div className="space-y-2">
                <Label className="text-sm">Signature Label</Label>
                <Input
                  value={settings.signature_label || ''}
                  onChange={(e) => handleChange("signature_label", e.target.value)}
                  placeholder="e.g., Authorized Signature"
                />
              </div>
            )}

            {settings.show_terms && (
              <div className="space-y-2">
                <Label className="text-sm">Terms & Conditions</Label>
                <Textarea
                  value={settings.terms_text || ''}
                  onChange={(e) => handleChange("terms_text", e.target.value || null)}
                  placeholder="Enter your terms and conditions..."
                  rows={3}
                />
              </div>
            )}

            <div className="space-y-2">
              <Label className="text-sm">Footer Text</Label>
              <Textarea
                value={settings.footer_text || ''}
                onChange={(e) => handleChange("footer_text", e.target.value || null)}
                placeholder="e.g., Thank you for your business!"
                rows={2}
              />
            </div>
          </AccordionContent>
        </AccordionItem>

        {/* Advanced Section */}
        <AccordionItem value="advanced" className="border rounded-lg px-4">
          <AccordionTrigger className="hover:no-underline">
            <div className="flex items-center gap-2">
              <Settings2 className="h-4 w-4" />
              <span>Advanced</span>
            </div>
          </AccordionTrigger>
          <AccordionContent className="space-y-3 pt-2">
            <div className="flex items-center justify-between">
              <div>
                <Label className="text-sm">Show extended status badges</Label>
                <p className="text-xs text-muted-foreground mt-1">
                  PAID, CANCELLED, and DRAFT badges always appear. Enable this to also show Sent, Viewed, Partial, etc.
                </p>
              </div>
              <Switch
                checked={settings.show_status_badge ?? false}
                onCheckedChange={(v) => handleChange("show_status_badge", v)}
              />
            </div>
            <div className="flex items-center justify-between">
              <div>
                <Label className="text-sm">Draft watermark</Label>
                <p className="text-xs text-muted-foreground mt-1">
                  Displays a diagonal "DRAFT" watermark on documents with draft status.
                </p>
              </div>
              <Switch
                checked={settings.watermark_text === 'DRAFT'}
                onCheckedChange={(v) => handleChange("watermark_text", v ? 'DRAFT' : null)}
              />
            </div>
          </AccordionContent>
        </AccordionItem>
      </Accordion>

      {/* Action Buttons */}
      <div className="flex justify-between sticky bottom-0 bg-background/95 backdrop-blur-sm py-4 border-t">
        {onCancel && (
          <Button variant="outline" onClick={onCancel}>
            Cancel
          </Button>
        )}
        <Button 
          onClick={handleSave} 
          disabled={isSaving || !settings.template_name}
          className="ml-auto"
        >
          {isSaving ? (
            <>
              <Loader2 className="mr-2 h-4 w-4 animate-spin" />
              Saving...
            </>
          ) : (
            "Save Template"
          )}
        </Button>
      </div>
    </div>
  );
}
