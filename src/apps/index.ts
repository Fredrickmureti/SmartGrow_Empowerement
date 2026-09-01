/**
 * Apps Module Index
 *
 * Central exports for the app modules retained by the microfinance convergence.
 * Sales, Purchases, Inventory, CRM, Projects and SMS apps were removed.
 */

// App Components (lazy loaded)
export { FinanceApp } from "./finance";
export { ContactsApp } from "./contacts";
export { LendingApp } from "./lending";
export { HRApp } from "./hr";

// Layouts
export { FinanceLayout } from "./finance";
export { ContactsLayout } from "./contacts";
export { LendingLayout } from "./lending";
// HRLayout was removed — each HR sub-app owns its own shell via HrAppShell.
