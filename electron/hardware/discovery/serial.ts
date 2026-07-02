/**
 * Serial discovery — main process.
 *
 * Thin wrapper around `serialport.SerialPort.list()`. Returns the same
 * shape across platforms; native bindings normalise `path`, `manufacturer`
 * and `pnpId` for us.
 *
 * Read-only — never opens a port.
 */

export interface SerialCandidate {
  transport: 'serial';
  path: string;
  manufacturer?: string | null;
  serialNumber?: string | null;
  pnpId?: string | null;
  vendorId?: string | null;
  productId?: string | null;
}

interface SerialPortLike {
  list: () => Promise<Array<{
    path: string;
    manufacturer?: string;
    serialNumber?: string;
    pnpId?: string;
    vendorId?: string;
    productId?: string;
  }>>;
}

export async function discoverSerialDevices(): Promise<SerialCandidate[]> {
  let mod: { SerialPort: SerialPortLike };
  try {
    mod = (await import('serialport' as never)) as unknown as { SerialPort: SerialPortLike };
  } catch {
    return [];
  }
  try {
    const ports = await mod.SerialPort.list();
    return ports.map((p) => ({
      transport: 'serial',
      path: p.path,
      manufacturer: p.manufacturer ?? null,
      serialNumber: p.serialNumber ?? null,
      pnpId: p.pnpId ?? null,
      vendorId: p.vendorId ?? null,
      productId: p.productId ?? null,
    }));
  } catch {
    return [];
  }
}
