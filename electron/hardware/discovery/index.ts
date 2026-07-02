/**
 * Discovery barrel — aggregates USB + Serial + Network into one snapshot.
 *
 * Audit Wave 9d.8 (P2): the snapshot now also carries a flat
 * `candidates` array of classified suggestions ({role, driver,
 * confidence}) ready to feed the "Connect device" wizard.
 */
import { discoverUsbDevices, type UsbCandidate } from './usb';
import { discoverSerialDevices, type SerialCandidate } from './serial';
import { discoverNetworkDevices, probeHost, type NetworkDiscoveryResult } from './network';
import { classifyUsb, type ClassifiedCandidate } from './classify';

export interface DiscoverySnapshot {
  ok: true;
  ranAt: number;
  usb: UsbCandidate[];
  serial: SerialCandidate[];
  network: NetworkDiscoveryResult;
  /** Flat, ranked list of suggested bindings. */
  candidates: ClassifiedCandidate[];
}

export async function discoverAllDevices(): Promise<DiscoverySnapshot> {
  const [usb, serial, network] = await Promise.all([
    discoverUsbDevices().catch(() => []),
    discoverSerialDevices().catch(() => []),
    discoverNetworkDevices().catch((): NetworkDiscoveryResult => ({ candidates: [], notImplemented: true, note: 'mDNS error' })),
  ]);

  const candidates: ClassifiedCandidate[] = [];
  for (const d of usb) {
    const c = classifyUsb(d);
    if (c) candidates.push(c);
  }
  for (const n of network.candidates) {
    if (n.classification) candidates.push(n.classification);
  }
  candidates.sort((a, b) => b.confidence - a.confidence);

  return { ok: true, ranAt: Date.now(), usb, serial, network, candidates };
}

export { probeHost, classifyUsb };
export type { UsbCandidate, SerialCandidate, NetworkDiscoveryResult, ClassifiedCandidate };
