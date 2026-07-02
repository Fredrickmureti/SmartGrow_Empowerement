
/**
 * Apps Module Index
 * 
 * Central exports for all app modules.
 */

// App Components (lazy loaded)
export { FinanceApp } from "./finance";
export { SalesApp } from "./sales";
export { ContactsApp } from "./contacts";
export { PurchasesApp } from "./purchases";
export { InventoryApp } from "./inventory";
export { HRApp } from "./hr";
export { CRMApp } from "./crm";
export { ProjectsApp } from "./projects";

// Layouts
export { FinanceLayout } from "./finance";
export { SalesLayout } from "./sales";
export { ContactsLayout } from "./contacts";
export { PurchasesLayout } from "./purchases";
export { InventoryLayout } from "./inventory";
// HRLayout was removed — each HR sub-app owns its own shell via HrAppShell.
export { CRMLayout } from "./crm";
export { ProjectsLayout } from "./projects";
// Sign app retired 2026-05-09.
export { SmsApp, SmsLayout } from "./sms";
