export * from "./usePOSRegisters";
export * from "./usePOSShifts";
export * from "./usePOSCart";
export * from "./usePOSProducts";
export * from "./usePOSTransaction";
export * from "./usePOSHeldTransactions";
export * from "./usePOSCashDrawer";
export * from "./usePOSCashMovementTypes";
export * from "./usePOSTransactionHistory";
export * from "./usePOSDiscounts";
export * from "./usePOSReports";
export * from "./usePOSReturns";
// useBarcodeScanner retired — the global kernel (useScanCapture mounted in
// AuthenticatedShell) + scanRouter/<BarcodeInputField> are the single source
// of scan events repo-wide. parseBarcodePayload (the only utility worth
// keeping) is re-exported below for back-compat.
export { parseBarcodePayload } from "./useBarcodeScanner";
export * from "./usePOSCustomers";
export * from "./usePOSSettings";
export * from "./usePOSOffline";
export * from "./usePOSProductCache";
export * from "./usePOSSessions";
export * from "./useManagerOverride";
export { usePOSTransactionOffline } from "./usePOSTransactionOffline";
export { usePOSCreditSale } from "./usePOSCreditSale";
// usePOSAccountingSync removed — GL posting is owned by the DB trigger
// `trg_pos_shift_close_journal` which calls `post_pos_shift_gl` on shift close.
// Manual replays go through the `replay_pos_shift_gl` RPC (see ShiftReportDialog).
export { usePOSLoyalty } from "./usePOSLoyalty";
export { usePOSAgeVerification } from "./usePOSAgeVerification";
export { usePOSStockSync } from "./usePOSStockSync";
export { usePOSEnhancedReports } from "./usePOSEnhancedReports";
export { usePOSEtims } from "./usePOSEtims";
export { usePOSPromotions } from "./usePOSPromotions";
export { usePOSCashiers } from "./usePOSCashiers";
export { usePOSSecuritySettings } from "./usePOSSecuritySettings";
export { useTerminalSession } from "./useTerminalSession";
export { usePOSSecurityAudit } from "./usePOSSecurityAudit";
export { usePOSVoid } from "./usePOSVoid";
export { usePrinterStatus, usePrintWithFallback } from "./usePrinterStatus";
export { usePOSSessionsOffline } from "./usePOSSessionsOffline";
// useHardwareSettings removed — use useHardwareProxy or useDeviceAssignments instead.
export { usePOSZReport, usePOSXReport } from "./usePOSReportViews";
export { usePOSInvoiceRequest } from "./usePOSInvoiceRequest";
// usePOSStockReservation removed — POS holds go through reserve_pos_stock /
// release_pos_stock_reservation, which now write the unified stock_reservations
// table (ADR 0082 · T3).
export { useHardwareEvent, useBarcodeScan, useScaleWeight, useDeviceDiscovery } from "./useHardwareEvents";

// Restaurant mode hooks
export { useFloorPlan } from "./useFloorPlan";
export { useTableSessions } from "./useTableSessions";
export { useKitchenDisplay } from "./useKitchenDisplay";
export { useTableBookings } from "./useTableBookings";
export { useCourses } from "./useCourses";

// Restaurant mode enhancements
export { useModifiers } from "./useModifiers";
export { useBillSplitting } from "./useBillSplitting";
export { useTableTransfer } from "./useTableTransfer";
export { useWaitlist } from "./useWaitlist";
export { useHappyHour } from "./useHappyHour";
