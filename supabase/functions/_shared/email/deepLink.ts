// Centralized notification deep-link resolver.
// Used by every notification/system email so CTAs are consistent and absolute.

export interface DeepLinkInput {
  baseUrl: string;
  category?: string | null;
  entity_type?: string | null;
  entity_id?: string | null;
  link?: string | null;
  notification_id?: string | null;
}

export interface DeepLinkOutput {
  url: string;
  label: string;
}

function abs(baseUrl: string, path: string): string {
  if (!path) return baseUrl;
  if (/^https?:\/\//i.test(path)) return path;
  const base = baseUrl.replace(/\/+$/, "");
  const p = path.startsWith("/") ? path : `/${path}`;
  return `${base}${p}`;
}

function defaultLabelFor(category: string, entity_type: string): string {
  if (category === "inventory") return "View product";
  if (category === "invoices" || category === "invoice") return "View invoice";
  if (category === "payments" || category === "payment") return "View payment";
  if (category === "estimate" || entity_type === "estimate") return "View estimate";
  if (category === "expenses") return "View expense";
  if (category === "bills") return "View bill";
  if (category === "pos") return "View transaction";
  if (category === "team") return "Open team";
  return "Open in app";
}

export function resolveNotificationDeepLink(opts: DeepLinkInput): DeepLinkOutput {
  const { baseUrl, link, notification_id } = opts;
  const cat = (opts.category || "").toLowerCase();
  const ent = (opts.entity_type || "").toLowerCase();
  const id = opts.entity_id;

  // 1. Trust caller-supplied absolute URLs.
  if (link && /^https?:\/\//i.test(link)) {
    return { url: link, label: defaultLabelFor(cat, ent) };
  }

  // 2. Entity-aware deep links.
  if (id) {
    if (cat === "inventory" || ["low_stock", "critical_stock", "out_of_stock", "product"].includes(ent)) {
      return { url: abs(baseUrl, `/inventory/products?highlight=${id}`), label: "View product" };
    }
    if (cat === "invoices" || cat === "invoice" || ent === "invoice" || ent === "invoice_overdue") {
      return { url: abs(baseUrl, `/sales/invoices?highlight=${id}`), label: ent === "invoice_overdue" ? "View overdue invoice" : "View invoice" };
    }
    if (cat === "payments" || cat === "payment" || ent === "payment" || ent === "invoice_payment") {
      return { url: abs(baseUrl, `/sales/payments?highlight=${id}`), label: "View payment" };
    }
    if (ent === "estimate" || cat === "estimate") {
      return { url: abs(baseUrl, `/sales/estimates?highlight=${id}`), label: "View estimate" };
    }
    if (cat === "expenses" || ent === "expense") {
      return { url: abs(baseUrl, `/expenses?highlight=${id}`), label: "View expense" };
    }
    if (ent === "bill" || cat === "bills") {
      return { url: abs(baseUrl, `/purchases/bills?highlight=${id}`), label: "View bill" };
    }
    if (cat === "pos" || ent === "pos_transaction") {
      return { url: abs(baseUrl, `/pos/transactions?highlight=${id}`), label: "View transaction" };
    }
    if (cat === "leave" || ent === "leave_request") {
      return { url: abs(baseUrl, `/hr/time-off?highlight=${id}`), label: "Review leave request" };
    }
    if (cat === "timesheets" || ent === "timesheet") {
      return { url: abs(baseUrl, `/hr/attendance?highlight=${id}`), label: "View timesheet" };
    }
    if (cat === "payslips" || ent === "payslip") {
      return { url: abs(baseUrl, `/hr/payroll?highlight=${id}`), label: "View payslip" };
    }
    if (cat === "team" || ent === "team_invitation" || ent === "user") {
      return { url: abs(baseUrl, `/settings?tab=team&highlight=${id}`), label: "Open team" };
    }
  }

  // 3. Caller-supplied relative path.
  if (link && link.trim().length > 0) {
    return { url: abs(baseUrl, link), label: defaultLabelFor(cat, ent) };
  }

  // 4. Fallback to in-app notification center.
  const fallback = notification_id
    ? abs(baseUrl, `/notifications?focus=${notification_id}`)
    : abs(baseUrl, `/notifications`);
  return { url: fallback, label: "Open in app" };
}

/**
 * Resolve the absolute base URL for app deep links. Prefers the
 * `app_base_url` platform setting, falls back to a Lovable preview URL
 * derived from the Supabase project ref.
 */
export async function resolveAppBaseUrl(
  // deno-lint-ignore no-explicit-any
  supabase: any,
  supabaseUrl: string,
): Promise<string> {
  const { data } = await supabase
    .from("platform_settings")
    .select("setting_value")
    .eq("setting_key", "app_base_url")
    .maybeSingle();
  const fromSetting = (data?.setting_value || "").trim();
  if (fromSetting) return fromSetting;
  const ref = (supabaseUrl.match(/https?:\/\/([^.]+)\./) || [])[1] || "app";
  return `https://${ref}.lovable.app`;
}
