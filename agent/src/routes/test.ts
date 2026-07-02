import net from 'node:net';

interface TestRequest {
  ipAddress: string;
  port: number;
  timeout?: number;
}

interface TestResponse {
  success: boolean;
  error?: string;
  responseTimeMs?: number;
}

export function handleTest(body: TestRequest): Promise<TestResponse> {
  const { ipAddress, port, timeout = 3000 } = body;

  if (!ipAddress || !port) {
    return Promise.resolve({
      success: false,
      error: 'Missing required fields: ipAddress, port',
    });
  }

  const start = Date.now();

  return new Promise((resolve) => {
    const socket = new net.Socket();
    let settled = false;

    const finish = (result: TestResponse) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve(result);
    };

    socket.setTimeout(timeout);

    socket.on('timeout', () =>
      finish({ success: false, error: `Connection timed out after ${timeout}ms` }),
    );

    socket.on('error', (err) =>
      finish({ success: false, error: err.message }),
    );

    socket.connect(port, ipAddress, () => {
      finish({ success: true, responseTimeMs: Date.now() - start });
    });
  });
}
