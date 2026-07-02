import {
  Accordion,
  AccordionContent,
  AccordionItem,
  AccordionTrigger,
} from "@/components/ui/accordion";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import { Slider } from "@/components/ui/slider";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Input } from "@/components/ui/input";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { AlertTriangle } from "lucide-react";
import type {
  ExtendedReceiptSettings,
  ItemDisplayFormat,
  SectionAlign,
  CurrencyDisplay,
  CurrencyPosition,
  ThousandsSeparator,
  DateFormat,
  TimeFormat,
} from "@/types/receipt";
import { ITEM_DISPLAY_FORMAT_OPTIONS } from "@/lib/receiptConfig";

// IANA time zones surfaced in the picker. Free-text input below lets power
// users type any IANA name; Intl.DateTimeFormat validates at render time.
const COMMON_TIMEZONES = [
  "UTC",
  "Africa/Nairobi", "Africa/Kampala", "Africa/Dar_es_Salaam",
  "Africa/Lagos", "Africa/Johannesburg", "Africa/Cairo",
  "Europe/London", "Europe/Paris", "Europe/Berlin",
  "America/New_York", "America/Chicago", "America/Denver", "America/Los_Angeles",
  "America/Sao_Paulo",
  "Asia/Dubai", "Asia/Kolkata", "Asia/Singapore", "Asia/Shanghai", "Asia/Tokyo",
  "Australia/Sydney",
];

const ALIGN_OPTIONS: { value: SectionAlign; label: string }[] = [
  { value: "left", label: "Left" },
  { value: "center", label: "Center" },
  { value: "right", label: "Right" },
];

function AlignSelect({
  value,
  onValueChange,
}: {
  value: SectionAlign | undefined;
  onValueChange: (v: SectionAlign) => void;
}) {
  return (
    <Select value={value ?? "left"} onValueChange={(v) => onValueChange(v as SectionAlign)}>
      <SelectTrigger className="w-full">
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        {ALIGN_OPTIONS.map((o) => (
          <SelectItem key={o.value} value={o.value}>{o.label}</SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}

interface ReceiptSectionEditorProps {
  settings: ExtendedReceiptSettings;
  onChange: (key: keyof ExtendedReceiptSettings, value: boolean | string | number | string[]) => void;
}

export function ReceiptSectionEditor({ settings, onChange }: ReceiptSectionEditorProps) {
  // R1 — width validation: tabular + SKU on 58mm leaves ~8 chars for product
  // names. Warn before save instead of silently truncating.
  const widthRisk =
    settings.paper_size === "58mm" &&
    settings.item_display_format === "tabular" &&
    settings.show_item_sku;

  return (
    <>
      {widthRisk && (
        <Alert variant="destructive" className="mb-4">
          <AlertTriangle className="h-4 w-4" />
          <AlertDescription className="text-xs">
            <strong>Layout warning.</strong> Tabular items + SKU column on
            58&nbsp;mm paper leaves about 8 characters for product names — they
            will be truncated. Switch to <em>Detailed</em>, hide the SKU column,
            or use 80&nbsp;mm paper.
          </AlertDescription>
        </Alert>
      )}
    <Accordion type="multiple" defaultValue={["header", "items", "totals"]} className="w-full">
      {/* Header Section */}
      <AccordionItem value="header">
        <AccordionTrigger className="text-sm font-medium">
          Header Section
        </AccordionTrigger>
        <AccordionContent className="space-y-4 pt-2">
          <div className="flex items-center justify-between">
            <div className="space-y-0.5">
              <Label className="text-sm">Show Logo</Label>
              <p className="text-xs text-muted-foreground">Display company logo</p>
            </div>
            <Switch
              checked={settings.show_logo}
              onCheckedChange={(checked) => onChange("show_logo", checked)}
            />
          </div>
          
          <div className="flex items-center justify-between">
            <div className="space-y-0.5">
              <Label className="text-sm">Store Name</Label>
              <p className="text-xs text-muted-foreground">Show organization name</p>
            </div>
            <Switch
              checked={settings.show_store_name}
              onCheckedChange={(checked) => onChange("show_store_name", checked)}
            />
          </div>
          
          <div className="flex items-center justify-between">
            <div className="space-y-0.5">
              <Label className="text-sm">Address</Label>
              <p className="text-xs text-muted-foreground">Include store address</p>
            </div>
            <Switch
              checked={settings.show_store_address}
              onCheckedChange={(checked) => onChange("show_store_address", checked)}
            />
          </div>
          
          <div className="flex items-center justify-between">
            <div className="space-y-0.5">
              <Label className="text-sm">Phone</Label>
              <p className="text-xs text-muted-foreground">Include phone number</p>
            </div>
            <Switch
              checked={settings.show_store_phone}
              onCheckedChange={(checked) => onChange("show_store_phone", checked)}
            />
          </div>
          
          <div className="flex items-center justify-between">
            <div className="space-y-0.5">
              <Label className="text-sm">Email</Label>
              <p className="text-xs text-muted-foreground">Include email address</p>
            </div>
            <Switch
              checked={settings.show_store_email}
              onCheckedChange={(checked) => onChange("show_store_email", checked)}
            />
          </div>
          
          <div className="space-y-2">
            <Label className="text-sm">Custom Header Text</Label>
            <Textarea
              placeholder="Tagline, registration number, etc."
              value={settings.receipt_header}
              onChange={(e) => onChange("receipt_header", e.target.value)}
              rows={2}
              className="text-sm"
            />
          </div>
        </AccordionContent>
      </AccordionItem>

      {/* Transaction Details */}
      <AccordionItem value="transaction">
        <AccordionTrigger className="text-sm font-medium">
          Transaction Details
        </AccordionTrigger>
        <AccordionContent className="space-y-4 pt-2">
          <div className="flex items-center justify-between">
            <div className="space-y-0.5">
              <Label className="text-sm">Receipt Number</Label>
            </div>
            <Switch
              checked={settings.show_receipt_number}
              onCheckedChange={(checked) => onChange("show_receipt_number", checked)}
            />
          </div>
          
          <div className="flex items-center justify-between">
            <div className="space-y-0.5">
              <Label className="text-sm">Date & Time</Label>
            </div>
            <Switch
              checked={settings.show_date_time}
              onCheckedChange={(checked) => onChange("show_date_time", checked)}
            />
          </div>
          
          <div className="flex items-center justify-between">
            <div className="space-y-0.5">
              <Label className="text-sm">Cashier Name</Label>
            </div>
            <Switch
              checked={settings.show_cashier_name}
              onCheckedChange={(checked) => onChange("show_cashier_name", checked)}
            />
          </div>
          
          {settings.show_cashier_name && (
            <div className="space-y-2 pl-4 border-l-2 border-muted">
              <Label className="text-sm">Cashier Label Format</Label>
              <Select
                value={settings.cashier_label_format || 'cashier'}
                onValueChange={(value) => onChange("cashier_label_format", value)}
              >
                <SelectTrigger className="w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="cashier">Cashier:</SelectItem>
                  <SelectItem value="served_by">You were served by:</SelectItem>
                </SelectContent>
              </Select>
            </div>
          )}
          
          <div className="flex items-center justify-between">
            <div className="space-y-0.5">
              <Label className="text-sm">Register ID</Label>
            </div>
            <Switch
              checked={settings.show_register_id}
              onCheckedChange={(checked) => onChange("show_register_id", checked)}
            />
          </div>
          
          <div className="flex items-center justify-between">
            <div className="space-y-0.5">
              <Label className="text-sm">Customer Name</Label>
            </div>
            <Switch
              checked={settings.show_customer_name}
              onCheckedChange={(checked) => onChange("show_customer_name", checked)}
            />
          </div>
        </AccordionContent>
      </AccordionItem>

      {/* Items Section */}
      <AccordionItem value="items">
        <AccordionTrigger className="text-sm font-medium">
          Items Section
        </AccordionTrigger>
        <AccordionContent className="space-y-4 pt-2">
          <div className="space-y-2">
            <Label className="text-sm">Item Display Format</Label>
            <Select
              value={settings.item_display_format || 'single-line'}
              onValueChange={(value) => onChange("item_display_format", value as ItemDisplayFormat)}
            >
              <SelectTrigger className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {ITEM_DISPLAY_FORMAT_OPTIONS.map((opt) => (
                  <SelectItem key={opt.value} value={opt.value}>
                    {opt.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <p className="text-xs text-muted-foreground">
              {ITEM_DISPLAY_FORMAT_OPTIONS.find(
                (o) => o.value === (settings.item_display_format || "single-line"),
              )?.description}
            </p>
          </div>
          
          <div className="flex items-center justify-between">
            <div className="space-y-0.5">
              <Label className="text-sm">Show SKU/Barcode</Label>
            </div>
            <Switch
              checked={settings.show_item_sku}
              onCheckedChange={(checked) => onChange("show_item_sku", checked)}
            />
          </div>
          
          <div className="flex items-center justify-between">
            <div className="space-y-0.5">
              <Label className="text-sm">Show Quantity</Label>
            </div>
            <Switch
              checked={settings.show_item_quantity}
              onCheckedChange={(checked) => onChange("show_item_quantity", checked)}
            />
          </div>
          
          <div className="flex items-center justify-between">
            <div className="space-y-0.5">
              <Label className="text-sm">Show Unit Price</Label>
            </div>
            <Switch
              checked={settings.show_unit_price}
              onCheckedChange={(checked) => onChange("show_unit_price", checked)}
            />
          </div>
          
          <div className="flex items-center justify-between">
            <div className="space-y-0.5">
              <Label className="text-sm">Show Item Discounts</Label>
            </div>
            <Switch
              checked={settings.show_item_discount}
              onCheckedChange={(checked) => onChange("show_item_discount", checked)}
            />
          </div>
          
          <div className="flex items-center justify-between">
            <div className="space-y-0.5">
              <Label className="text-sm">Truncate Long Names</Label>
              <p className="text-xs text-muted-foreground">Shorten long product names</p>
            </div>
            <Switch
              checked={settings.truncate_long_names}
              onCheckedChange={(checked) => onChange("truncate_long_names", checked)}
            />
          </div>
          
          {settings.truncate_long_names && (
            <div className="space-y-2">
              <Label className="text-sm">Max Name Length: {settings.max_item_name_length} chars</Label>
              <Slider
                value={[settings.max_item_name_length]}
                onValueChange={([value]) => onChange("max_item_name_length", value)}
                min={15}
                max={50}
                step={1}
              />
            </div>
          )}

          {/* Stage R2 — show modifiers / notes per line */}
          <div className="flex items-center justify-between pt-2">
            <div className="space-y-0.5">
              <Label className="text-sm">Show Item Modifiers &amp; Notes</Label>
              <p className="text-xs text-muted-foreground">
                Indented under each line: modifier names (e.g. "+ Extra cheese")
                and any per-line note from the cashier.
              </p>
            </div>
            <Switch
              checked={settings.show_item_modifiers ?? true}
              onCheckedChange={(checked) => onChange("show_item_modifiers", checked)}
            />
          </div>
        </AccordionContent>
      </AccordionItem>

      {/* Totals Section */}
      <AccordionItem value="totals">
        <AccordionTrigger className="text-sm font-medium">
          Totals & Payment
        </AccordionTrigger>
        <AccordionContent className="space-y-4 pt-2">
          <div className="flex items-center justify-between">
            <div className="space-y-0.5">
              <Label className="text-sm">Show Subtotal</Label>
            </div>
            <Switch
              checked={settings.show_subtotal}
              onCheckedChange={(checked) => onChange("show_subtotal", checked)}
            />
          </div>
          
          <div className="flex items-center justify-between">
            <div className="space-y-0.5">
              <Label className="text-sm">Show Discounts</Label>
            </div>
            <Switch
              checked={settings.show_discount_total}
              onCheckedChange={(checked) => onChange("show_discount_total", checked)}
            />
          </div>
          
          <div className="flex items-center justify-between">
            <div className="space-y-0.5">
              <Label className="text-sm">Show "You Saved"</Label>
              <p className="text-xs text-muted-foreground">Display savings message</p>
            </div>
            <Switch
              checked={settings.show_savings}
              onCheckedChange={(checked) => onChange("show_savings", checked)}
            />
          </div>
          
          <div className="flex items-center justify-between">
            <div className="space-y-0.5">
              <Label className="text-sm">Tax Breakdown</Label>
            </div>
            <Switch
              checked={settings.show_tax_breakdown}
              onCheckedChange={(checked) => onChange("show_tax_breakdown", checked)}
            />
          </div>
          
          <div className="flex items-center justify-between">
            <div className="space-y-0.5">
              <Label className="text-sm">Show Tax Rate</Label>
            </div>
            <Switch
              checked={settings.show_tax_rate}
              onCheckedChange={(checked) => onChange("show_tax_rate", checked)}
            />
          </div>
          
          <div className="flex items-center justify-between">
            <div className="space-y-0.5">
              <Label className="text-sm">Payment Method</Label>
            </div>
            <Switch
              checked={settings.show_payment_method}
              onCheckedChange={(checked) => onChange("show_payment_method", checked)}
            />
          </div>
          
          <div className="flex items-center justify-between">
            <div className="space-y-0.5">
              <Label className="text-sm">Amount Tendered</Label>
            </div>
            <Switch
              checked={settings.show_amount_tendered}
              onCheckedChange={(checked) => onChange("show_amount_tendered", checked)}
            />
          </div>
          
          <div className="flex items-center justify-between">
            <div className="space-y-0.5">
              <Label className="text-sm">Change Due</Label>
            </div>
            <Switch
              checked={settings.show_change_due}
              onCheckedChange={(checked) => onChange("show_change_due", checked)}
            />
          </div>
        </AccordionContent>
      </AccordionItem>

      {/* Footer Section */}
      <AccordionItem value="footer">
        <AccordionTrigger className="text-sm font-medium">
          Footer Section
        </AccordionTrigger>
        <AccordionContent className="space-y-4 pt-2">
          <div className="space-y-2">
            <Label className="text-sm">Thank You Message</Label>
            <Textarea
              placeholder="Thank you for your purchase!"
              value={settings.receipt_footer}
              onChange={(e) => onChange("receipt_footer", e.target.value)}
              rows={2}
              className="text-sm"
            />
          </div>
          
          <div className="flex items-center justify-between">
            <div className="space-y-0.5">
              <Label className="text-sm">Show Return Policy</Label>
            </div>
            <Switch
              checked={settings.show_return_policy}
              onCheckedChange={(checked) => onChange("show_return_policy", checked)}
            />
          </div>
          
          {settings.show_return_policy && (
            <div className="space-y-2">
              <Label className="text-sm">Return Policy Text</Label>
              <Textarea
                placeholder="Returns accepted within 30 days with receipt..."
                value={settings.return_policy_text}
                onChange={(e) => onChange("return_policy_text", e.target.value)}
                rows={2}
                className="text-sm"
              />
            </div>
          )}
          
          <div className="flex items-center justify-between">
            <div className="space-y-0.5">
              <Label className="text-sm">Show Barcode</Label>
              <p className="text-xs text-muted-foreground">Receipt barcode for returns</p>
            </div>
            <Switch
              checked={settings.show_barcode}
              onCheckedChange={(checked) => onChange("show_barcode", checked)}
            />
          </div>
          
          <div className="flex items-center justify-between">
            <div className="space-y-0.5">
              <Label className="text-sm">Show QR Code</Label>
              <p className="text-xs text-muted-foreground">QR code for digital receipt</p>
            </div>
            <Switch
              checked={settings.show_qr_code}
              onCheckedChange={(checked) => onChange("show_qr_code", checked)}
            />
          </div>
        </AccordionContent>
      </AccordionItem>

      {/* Compliance Section */}
      <AccordionItem value="compliance">
        <AccordionTrigger className="text-sm font-medium">
          Compliance (eTIMS)
        </AccordionTrigger>
        <AccordionContent className="space-y-4 pt-2">
          <div className="flex items-center justify-between">
            <div className="space-y-0.5">
              <Label className="text-sm">Show eTIMS Info</Label>
              <p className="text-xs text-muted-foreground">KRA tax compliance info</p>
            </div>
            <Switch
              checked={settings.show_etims_info}
              onCheckedChange={(checked) => onChange("show_etims_info", checked)}
            />
          </div>
          
          <div className="flex items-center justify-between">
            <div className="space-y-0.5">
              <Label className="text-sm">Show eTIMS QR Code</Label>
              <p className="text-xs text-muted-foreground">Verification QR code</p>
            </div>
            <Switch
              checked={settings.show_etims_qr}
              onCheckedChange={(checked) => onChange("show_etims_qr", checked)}
            />
          </div>
        </AccordionContent>
      </AccordionItem>
      {/* ── R1: Section Alignment ─────────────────────────────────────── */}
      <AccordionItem value="alignment">
        <AccordionTrigger className="text-sm font-medium">
          Section Alignment
        </AccordionTrigger>
        <AccordionContent className="space-y-4 pt-2">
          <p className="text-xs text-muted-foreground">
            Per-section text alignment for printed receipts. Defaults match
            traditional thermal-receipt layout.
          </p>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <div className="space-y-1.5">
              <Label className="text-sm">Header (store / logo)</Label>
              <AlignSelect
                value={settings.header_align}
                onValueChange={(v) => onChange("header_align", v)}
              />
            </div>
            <div className="space-y-1.5">
              <Label className="text-sm">Title &amp; meta</Label>
              <AlignSelect
                value={settings.meta_align}
                onValueChange={(v) => onChange("meta_align", v)}
              />
            </div>
            <div className="space-y-1.5">
              <Label className="text-sm">Items header</Label>
              <AlignSelect
                value={settings.items_header_align}
                onValueChange={(v) => onChange("items_header_align", v)}
              />
            </div>
            <div className="space-y-1.5">
              <Label className="text-sm">Totals block</Label>
              <AlignSelect
                value={settings.totals_align}
                onValueChange={(v) => onChange("totals_align", v)}
              />
            </div>
            <div className="space-y-1.5">
              <Label className="text-sm">Footer</Label>
              <AlignSelect
                value={settings.footer_align}
                onValueChange={(v) => onChange("footer_align", v)}
              />
            </div>
          </div>
        </AccordionContent>
      </AccordionItem>

      {/* ── R1: Currency & Numbers ────────────────────────────────────── */}
      <AccordionItem value="currency">
        <AccordionTrigger className="text-sm font-medium">
          Currency &amp; Numbers
        </AccordionTrigger>
        <AccordionContent className="space-y-4 pt-2">
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <div className="space-y-1.5">
              <Label className="text-sm">Display</Label>
              <Select
                value={settings.currency_display ?? "code"}
                onValueChange={(v) => onChange("currency_display", v as CurrencyDisplay)}
              >
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="symbol">Symbol (e.g. $, KSh, €)</SelectItem>
                  <SelectItem value="code">Currency code (e.g. USD)</SelectItem>
                  <SelectItem value="none">None</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1.5">
              <Label className="text-sm">Position</Label>
              <Select
                value={settings.currency_position ?? "before"}
                onValueChange={(v) => onChange("currency_position", v as CurrencyPosition)}
              >
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="before">Before amount ($ 12.00)</SelectItem>
                  <SelectItem value="after">After amount (12.00 $)</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1.5">
              <Label className="text-sm">Symbol override (optional)</Label>
              <Input
                placeholder="Leave blank to use default"
                value={settings.currency_symbol_override ?? ""}
                onChange={(e) => onChange("currency_symbol_override", e.target.value)}
              />
            </div>
            <div className="space-y-1.5">
              <Label className="text-sm">Decimal places</Label>
              <Select
                value={String(settings.decimal_places ?? 2)}
                onValueChange={(v) => onChange("decimal_places", Number(v))}
              >
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  {[0, 1, 2, 3, 4].map((n) => (
                    <SelectItem key={n} value={String(n)}>{n}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1.5 sm:col-span-2">
              <Label className="text-sm">Thousands separator</Label>
              <Select
                value={(settings.thousands_separator ?? ",") === "" ? "none" : (settings.thousands_separator ?? ",")}
                onValueChange={(v) =>
                  onChange("thousands_separator", (v === "none" ? "" : v) as ThousandsSeparator)
                }
              >
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value=",">Comma — 1,234.56</SelectItem>
                  <SelectItem value=".">Period — 1.234,56</SelectItem>
                  <SelectItem value=" ">Space — 1 234.56</SelectItem>
                  {/* Radix Select forbids empty-string values — use "none" sentinel and map to "" on save. */}
                  <SelectItem value="none">None — 1234.56</SelectItem>
                </SelectContent>
              </Select>
            </div>
          </div>
        </AccordionContent>
      </AccordionItem>

      {/* ── R1: Date & Time ──────────────────────────────────────────── */}
      <AccordionItem value="datetime">
        <AccordionTrigger className="text-sm font-medium">
          Date &amp; Time
        </AccordionTrigger>
        <AccordionContent className="space-y-4 pt-2">
          <p className="text-xs text-muted-foreground">
            Time zone is configured per company in Company Settings. Receipts
            print times in the company's IANA time zone.
          </p>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <div className="space-y-1.5">
              <Label className="text-sm">Date format</Label>
              <Select
                value={settings.date_format ?? "iso"}
                onValueChange={(v) => onChange("date_format", v as DateFormat)}
              >
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="iso">ISO — 2026-05-12</SelectItem>
                  <SelectItem value="dmy">DMY — 12/05/2026</SelectItem>
                  <SelectItem value="mdy">MDY — 05/12/2026</SelectItem>
                  <SelectItem value="long">Long — 12 May 2026</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1.5">
              <Label className="text-sm">Time format</Label>
              <Select
                value={settings.time_format ?? "24h"}
                onValueChange={(v) => onChange("time_format", v as TimeFormat)}
              >
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="24h">24-hour (14:30)</SelectItem>
                  <SelectItem value="12h">12-hour (02:30 PM)</SelectItem>
                  <SelectItem value="none">No time</SelectItem>
                </SelectContent>
              </Select>
            </div>
          </div>
        </AccordionContent>
      </AccordionItem>
      {/* ── R2: Print Behavior (copies, refund banner, cut/feed) ─────── */}
      <AccordionItem value="print-behavior">
        <AccordionTrigger className="text-sm font-medium">
          Print Behavior
        </AccordionTrigger>
        <AccordionContent className="space-y-4 pt-2">
          <p className="text-xs text-muted-foreground">
            Physical-printer behavior. Defaults reproduce traditional
            single-copy, full-cut thermal output.
          </p>

          <div className="flex items-center justify-between">
            <div className="space-y-0.5">
              <Label className="text-sm">Show "REFUND" banner on returns</Label>
              <p className="text-xs text-muted-foreground">
                Centered double-size banner above the TOTAL row when the
                document total is negative.
              </p>
            </div>
            <Switch
              checked={settings.show_refund_banner ?? true}
              onCheckedChange={(checked) => onChange("show_refund_banner", checked)}
            />
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <div className="space-y-1.5">
              <Label className="text-sm">Number of copies</Label>
              <Select
                value={String(settings.copies ?? 1)}
                onValueChange={(v) => onChange("copies", Number(v))}
              >
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="1">1 (single)</SelectItem>
                  <SelectItem value="2">2 (e.g. merchant + customer)</SelectItem>
                  <SelectItem value="3">3</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1.5">
              <Label className="text-sm">Paper cut</Label>
              <Select
                value={settings.cut_mode ?? "full"}
                onValueChange={(v) => onChange("cut_mode", v)}
              >
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="full">Full cut</SelectItem>
                  <SelectItem value="partial">Partial cut (paper bridge)</SelectItem>
                  <SelectItem value="none">None (manual tear-off)</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1.5 sm:col-span-2">
              <Label className="text-sm">
                Feed lines before cut: {settings.feed_lines_after ?? 4}
              </Label>
              <Slider
                value={[settings.feed_lines_after ?? 4]}
                onValueChange={([v]) => onChange("feed_lines_after", v)}
                min={0}
                max={10}
                step={1}
              />
            </div>
            {(settings.copies ?? 1) > 1 && (
              <div className="space-y-1.5 sm:col-span-2">
                <Label className="text-sm">Per-copy banner labels</Label>
                <Input
                  placeholder="MERCHANT COPY, CUSTOMER COPY"
                  value={(settings.copy_labels ?? []).join(", ")}
                  onChange={(e) => {
                    const arr = e.target.value
                      .split(",")
                      .map((s) => s.trim())
                      .filter((s, i) => i < (settings.copies ?? 1));
                    onChange("copy_labels", arr);
                  }}
                />
                <p className="text-xs text-muted-foreground">
                  Comma-separated. Leave blank to print copies without
                  banners. Extra labels beyond the copy count are ignored.
                </p>
              </div>
            )}
          </div>
        </AccordionContent>
      </AccordionItem>
    </Accordion>
    </>
  );
}

// Re-export for sibling settings pages that need the timezone list (e.g.
// CompanySettings) without duplicating the constant.
export { COMMON_TIMEZONES };
