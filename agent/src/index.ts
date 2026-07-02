import { createServer } from './server.js';
import { getAuthToken } from './auth.js';

const PORT = parseInt(process.env.AGENT_PORT || '8043', 10);

const server = createServer();

server.listen(PORT, '0.0.0.0', () => {
  const token = getAuthToken();
  console.log(`\n  🖨️  POS Hardware Agent v1.0.0`);
  console.log(`  Listening on http://localhost:${PORT}`);
  if (token) {
    console.log(`  Auth token: ${token.substring(0, 8)}…`);
    console.log(`  Full token saved to ~/.pos-agent-token`);
    console.log(`  Set AGENT_AUTH_DISABLED=1 to skip auth (dev mode)`);
  } else {
    console.log(`  Auth: DISABLED (dev mode)`);
  }
  console.log(`  Press Ctrl+C to stop\n`);
});
