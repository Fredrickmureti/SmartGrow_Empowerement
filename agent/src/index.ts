import { createServer } from './server.js';
import { getAuthToken } from './auth.js';
import { logger } from './logger.js';

const PORT = parseInt(process.env.AGENT_PORT || '8043', 10);

const server = createServer();

server.listen(PORT, '127.0.0.1', () => {
  const token = getAuthToken();
  logger.info('edge_started', { port: PORT, auth: Boolean(token) });
  console.log(`\n  AccrualFlow Edge — Hardware Runtime v1.1.0-edge.p1`);
  console.log(`  Listening on http://127.0.0.1:${PORT} (loopback only)`);
  if (token) {
    console.log(`  Auth token: ${token.substring(0, 8)}…  (full token in ~/.pos-agent-token)`);
  } else {
    console.log(`  Auth: DISABLED (dev mode)`);
  }
  console.log(`  Health:  GET  /health`);
  console.log(`  Support: GET  /support-bundle  (auth required)`);
  console.log(`  Press Ctrl+C to stop\n`);
});
