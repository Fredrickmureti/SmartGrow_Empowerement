"use strict";
/**
 * IPaymentTerminalDriver — vendor-agnostic contract for EMV / contactless
 * payment terminals. Implemented by `MockTerminalDriver` (default) and,
 * in future loops, `StripeTerminalDriver` / `AdyenTerminalDriver` /
 * `VerifoneTerminalDriver`. The interface is intentionally narrower than
 * any single vendor SDK so the SaleSaga never leaks vendor types.
 *
 * Money is always handled in minor units (cents) to keep the FSM and
 * the persistence layer integer-only.
 */
Object.defineProperty(exports, "__esModule", { value: true });
//# sourceMappingURL=IPaymentTerminalDriver.js.map