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

export function handlePrint(body: PrintRequest): Promise<PrintResponse> {
  const { ipAddress, port, data, timeout = 5000 } = body;

  if (!ipAddress || !port || !Array.isArray(data)) {
    return Promise.resolve({
      success: false,
      error: 'Missing required fields: ipAddress, port, data',
    });
  }

  return new Promise((resolve) => {
    const socket = new net.Socket();
    const buf = Buffer.from(data);
    let settled = false;

    const finish = (result: PrintResponse) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve(result);
    };

    socket.setTimeout(timeout);

    socket.on('timeout', () =>
      finish({ success: false, error: `Connection to ${ipAddress}:${port} timed out` }),
    );

    socket.on('error', (err) =>
      finish({ success: false, error: err.message }),
    );

    socket.connect(port, ipAddress, () => {
      socket.write(buf, (err) => {
        if (err) {
          finish({ success: false, error: err.message });
        } else {
          finish({ success: true, bytesWritten: buf.length });
        }
      });
    });
  });
}
