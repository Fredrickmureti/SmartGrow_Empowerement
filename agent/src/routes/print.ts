import net from 'node:net';

interface PrintRequest {
  ipAddress: string;
  port: number;
  data: number[];
  timeout?: number;
}

interface PrintResponse {
  success: boolean;
  error?: string;
  bytesWritten?: number;
}

/**
 * Per-endpoint FIFO queue. Most raw-9100 printers (and the ESC/POS emulator)
 * accept exactly one TCP session at a time; overlapping jobs to the same
 * host:port collide and silently lose bytes. Different endpoints stay parallel.
 */
const endpointQueues = new Map<string, Promise<unknown>>();

function endpointKey(ipAddress: string, port: number): string {
  return `${String(ipAddress).trim().toLowerCase()}:${port}`;
}

export function handlePrint(body: PrintRequest): Promise<PrintResponse> {
  const { ipAddress, port, data, timeout = 5000 } = body;

  if (!ipAddress || !port || !Array.isArray(data)) {
    return Promise.resolve({
      success: false,
      error: 'Missing required fields: ipAddress, port, data',
    });
  }

  const key = endpointKey(ipAddress, port);
  const prev = endpointQueues.get(key) ?? Promise.resolve();
  const run = prev
    .catch(() => undefined)
    .then(() => sendToPrinter(ipAddress, port, data, timeout));
  endpointQueues.set(key, run);
  void run.finally(() => {
    if (endpointQueues.get(key) === run) endpointQueues.delete(key);
  });
  return run;
}

function sendToPrinter(
  ipAddress: string,
  port: number,
  data: number[],
  timeout: number,
): Promise<PrintResponse> {
  return new Promise((resolve) => {
    const socket = new net.Socket();
    const buf = Buffer.from(data);
    let settled = false;

    const finish = (result: PrintResponse, destroy = true) => {
      if (settled) return;
      settled = true;
      if (destroy) socket.destroy();
      resolve(result);
    };

    socket.setTimeout(timeout);

    socket.on('timeout', () =>
      finish({ success: false, error: `Connection to ${ipAddress}:${port} timed out` }),
    );

    socket.on('error', (err) =>
      finish({ success: false, error: err.message }),
    );

    // Resolve only once the socket is fully closed: destroying right after the
    // write callback can RST the connection before the receiver has consumed
    // the payload, which truncates or drops the label/receipt entirely.
    socket.on('close', () => finish({ success: true, bytesWritten: buf.length }, false));

    socket.connect(port, ipAddress, () => {
      socket.end(buf, (err?: Error | null) => {
        if (err) {
          finish({ success: false, error: err.message });
        }
      });
    });
  });
}
