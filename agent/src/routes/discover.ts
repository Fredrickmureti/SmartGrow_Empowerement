import net from 'node:net';
import os from 'node:os';

interface DeviceInfo {
  type: 'network';
  identifier: string;
  name?: string;
  ipAddress: string;
  port: number;
}

interface DiscoverResponse {
  devices: DeviceInfo[];
}

function getLocalSubnet(): string {
  const interfaces = os.networkInterfaces();
  for (const name of Object.keys(interfaces)) {
    for (const iface of interfaces[name] || []) {
      if (iface.family === 'IPv4' && !iface.internal) {
        const parts = iface.address.split('.');
        return `${parts[0]}.${parts[1]}.${parts[2]}`;
      }
    }
  }
  return '192.168.1';
}

function probeHost(ip: string, port: number, timeout: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = new net.Socket();
    let done = false;
    const finish = (result: boolean) => {
      if (done) return;
      done = true;
      socket.destroy();
      resolve(result);
    };
    socket.setTimeout(timeout);
    socket.on('timeout', () => finish(false));
    socket.on('error', () => finish(false));
    socket.connect(port, ip, () => finish(true));
  });
}

export async function handleDiscover(subnet: string): Promise<DiscoverResponse> {
  const base = subnet === 'auto' ? getLocalSubnet() : subnet;
  const port = 9100; // standard raw print port
  const timeout = 500;
  const devices: DeviceInfo[] = [];

  // Scan .1 — .254 in parallel batches of 50
  const ips = Array.from({ length: 254 }, (_, i) => `${base}.${i + 1}`);
  const batchSize = 50;

  for (let i = 0; i < ips.length; i += batchSize) {
    const batch = ips.slice(i, i + batchSize);
    const results = await Promise.all(
      batch.map(async (ip) => ({ ip, open: await probeHost(ip, port, timeout) })),
    );
    for (const { ip, open } of results) {
      if (open) {
        devices.push({
          type: 'network',
          identifier: `${ip}:${port}`,
          ipAddress: ip,
          port,
          name: `Printer at ${ip}`,
        });
      }
    }
  }

  return { devices };
}
