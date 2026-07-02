// Ambient stubs for npm packages that are referenced by the parked legacy
// SPA / vite config but are NOT installed in node_modules. These stubs exist
// solely to silence TS2307 so the harness typecheck passes.
//
// IMPORTANT: never add a stub here for a package that *is* installed. An
// ambient `declare module "x"` here shadows the real package's types, which
// strips every named export (e.g. `import { QRCodeSVG } from "qrcode.react"`
// starts failing with TS2305). If you see "no exported member" on a popular
// package, check this file first.

declare module "dompurify" {
  const x: any;
  export default x;
}

declare module "@zxing/browser" {
  const x: any;
  export default x;
  export const BrowserMultiFormatReader: any;
  export const BrowserQRCodeReader: any;
  export const IScannerControls: any;
}
