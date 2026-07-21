/**
 * NumericKeypad — legacy shim.
 *
 * The keypad is now implemented by `POSKeypad`, which wraps
 * `react-simple-keyboard` and scales to its container. Existing callers
 * keep working through this re-export; new code should import
 * `POSKeypad` directly.
 */
export { POSKeypad as NumericKeypad } from "./POSKeypad";
