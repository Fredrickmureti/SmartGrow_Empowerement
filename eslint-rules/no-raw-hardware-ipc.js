/**
 * ESLint rule: forbid raw hardware-IPC channels and native USB/serial
 * imports in renderer code (src/**).
 *
 * After Phase 1.3, the only sanctioned hardware entry points are:
 *   - `window.pos.hardware.exec(...)`        (capability-scoped preload)
 *   - `hardwareClient` from @/services/hardware/HardwareClient
 *
 * Anything else (legacy `window.electronAPI.usb`, `electronAPI.serial`,
 * `ipcRenderer.invoke('usb:print', …)`, `import 'usb'`, `import 'serialport'`,
 * `import 'noble'`) leaks the orchestration responsibility back to the
 * renderer and is rejected at build time.
 *
 * Scope: `src/**`. Tests under `src/test/**` and the main bundle
 * (`electron/**`, `agent/**`) are exempt.
 */

const FORBIDDEN_MODULES = new Set(['usb', 'node-usb', 'serialport', '@serialport/bindings-cpp', 'noble', '@abandonware/noble']);
const FORBIDDEN_CHANNELS = ['usb:print', 'usb:open-drawer', 'usb:list-devices', 'serial:write', 'serial:connect', 'serial:list-ports'];
const FORBIDDEN_API_PATHS = [
  'electronAPI.usb',
  'electronAPI.serial',
  'electronAPI.networkPrinter',
  'electronAPI.customerDisplay',
];

// Track H2 — after the preload trim, `window.electronAPI` does not exist
// anywhere at runtime. Any reference is an architectural regression: it
// either means a renderer module is using the legacy surface, or that a
// new module is being onboarded against a dead namespace.
const FORBIDDEN_ROOT_PATHS = [
  'window.electronAPI',
];

// ADR-0014 Track 4 — these service files are the renderer-side legacy
// orchestration layer and are slated for deletion in Track 4b. Importing
// them from new code is an architectural regression: hardware calls must
// go through `hardwareClient` (which itself routes via
// `window.pos.hardware.exec` into the main-process CommandRouter).
const DEPRECATED_SERVICE_IMPORTS = new Set([
  '@/services/hardware/HardwareProxy',
  '@/services/hardware/PrinterService',
  '@/services/hardware/CashDrawerService',
  '@/services/hardware/ScaleService',
  '@/services/hardware/CustomerDisplayService',
  '@/services/hardware/IoTBoxClient',
  '@/services/hardware/ElectronBridge',
  '@/services/hardware/transport/ElectronTransport',
  '@/services/hardware/transport/LocalAgentTransport',
  '@/services/hardware/interfaces/NetworkPrinterInterface',
]);

// Phase 2 single registry: `device_assignments` is canonical. Wave 9b dropped
// the legacy `pos_hardware_configs` table entirely, so any new reference is a
// hard regression — no allow-list.
const LEGACY_HW_TABLE = 'pos_hardware_configs';
const LEGACY_HW_TABLE_ALLOWED_FILES = [];

/** @type {import('eslint').Rule.RuleModule} */
module.exports = {
  meta: {
    type: 'problem',
    docs: { description: 'Forbid raw hardware IPC and native USB/serial imports in renderer code.' },
    schema: [],
    messages: {
      nativeImport: 'Renderer must not import "{{ name }}". Use hardwareClient (window.pos.hardware.exec) so orchestration stays in Electron main.',
      rawChannel: 'Raw IPC channel "{{ name }}" is forbidden in renderer code. Route through hardwareClient (window.pos.hardware.exec).',
      legacyApi: 'window.electronAPI.{{ surface }} is the legacy hardware surface. Use window.pos.hardware.exec via hardwareClient instead.',
      deprecatedService: 'Import from "{{ name }}" is deprecated and scheduled for deletion (ADR-0014 Track 4b). Use `hardwareClient` from @/services/hardware/HardwareClient instead.',
    },
  },
  create(context) {
    const filename = context.getFilename();
    // Allow tests, mocks, and Electron main/agent bundles.
    // Also allow the deprecated service files themselves to import each
    // other during the migration window — only NEW call sites are caught.
    if (
      filename.includes('/src/test/') ||
      filename.includes('/electron/') ||
      filename.includes('/agent/') ||
      filename.includes('/src/services/hardware/')
    ) return {};
    // Only enforce inside src/**.
    if (!filename.includes('/src/')) return {};

    const legacyAllowed = LEGACY_HW_TABLE_ALLOWED_FILES.some((p) => filename.endsWith(p));

    return {
      ImportDeclaration(node) {
        const src = node.source && node.source.value;
        if (typeof src !== 'string') return;
        if (FORBIDDEN_MODULES.has(src)) {
          context.report({ node, messageId: 'nativeImport', data: { name: src } });
          return;
        }
        if (DEPRECATED_SERVICE_IMPORTS.has(src)) {
          context.report({ node, messageId: 'deprecatedService', data: { name: src } });
        }
      },
      Literal(node) {
        if (typeof node.value !== 'string') return;
        if (FORBIDDEN_CHANNELS.includes(node.value)) {
          context.report({ node, messageId: 'rawChannel', data: { name: node.value } });
          return;
        }
        if (!legacyAllowed && node.value === LEGACY_HW_TABLE) {
          context.report({
            node,
            message: `Direct reference to legacy table "${LEGACY_HW_TABLE}" is forbidden. Use the device_assignments table via useDeviceAssignments (Phase 2 single registry).`,
          });
        }
      },
      MemberExpression(node) {
        // Detect `window.electronAPI.usb` / `window.electronAPI.serial`
        const text = context.getSourceCode().getText(node);
        for (const path of FORBIDDEN_API_PATHS) {
          if (text === path || text === `window.${path}`) {
            context.report({ node, messageId: 'legacyApi', data: { surface: path.split('.').pop() } });
            return;
          }
        }
      },
    };
  },
};
