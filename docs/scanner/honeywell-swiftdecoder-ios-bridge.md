# Honeywell SwiftDecoder — iOS WebView Bridge

Web-side contract for an iOS app shell that wraps the Lovable mobile
scanner page in a `WKWebView` and forwards SwiftDecoder scans into the
page.

The web seam already ships: `swiftDecoderAdapter`, the
`honeywell-ios` vendor branch in `detectNativeScanner`, and the
matching branch in `useNativeScanner`. An iOS team can ship the wrapper
without further changes here.

## Sentinel

Before navigating the WebView to `/pos/scan#<token>`, the iOS host
injects:

```js
window.__swiftDecoderBridge__ = { version: "1" };
```

`detectNativeScanner` keys on this property's presence (combined with
an iOS user-agent) and returns
`{ vendor: "honeywell-ios", label: "SwiftDecoder", … }`.

## Scan delivery

For every decoded barcode the host fires:

```js
window.dispatchEvent(new CustomEvent("swiftdecoder", {
  detail: {
    data:   "<barcode>",
    codeId: "<symbology>",  // optional, e.g. "EAN-13", "Code128"
    aimId:  "<aim>",        // optional, e.g. "]E0"
  },
}));
```

The adapter deduplicates identical codes within 200 ms.

## Optional bridge hook

If the host also assigns `window.__swiftDecoderBridge__.onScan`, the
adapter wraps it so any host-side handler keeps firing while the web
page is paired.

## Operator toggle

The "Use device scanner" chip in the cockpit metrics row enables /
disables the adapter at runtime. Persisted per-tab in
`sessionStorage.pos.scanner.useDeviceScanner`.

## Out of scope (host responsibility)

- Camera permission for SwiftDecoder.
- Battery / thermals / wake-lock policy.
- Symbology profile + decoder configuration on the iOS side.
