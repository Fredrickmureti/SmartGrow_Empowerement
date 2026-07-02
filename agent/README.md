# POS Hardware Agent

A standalone local service that bridges your browser-based POS to USB and network printers. This is the "IoT Box" equivalent — it runs on the same machine or LAN as the POS browser and exposes an HTTP API that the web app's `IoTBoxClient` already speaks.

## Quick Start

```bash
cd agent
npm install
npm run dev
```

The agent starts on `http://localhost:8043`. Your POS web app will automatically detect it and show "Online" status.

## Connecting Your Virtual Printer

If you have a virtual printer running on `localhost:8000`:

1. **Test connectivity** (agent must be running):
   ```bash
   curl -X POST http://localhost:8043/test \
     -H "Content-Type: application/json" \
     -d '{"ipAddress":"127.0.0.1","port":8000,"timeout":3000}'
   ```

2. **Send a test print**:
   ```bash
   curl -X POST http://localhost:8043/print \
     -H "Content-Type: application/json" \
     -d '{"ipAddress":"127.0.0.1","port":8000,"data":[27,64,72,101,108,108,111,10,29,86,0]}'
   ```
   This sends: ESC/POS init → "Hello" → line feed → cut paper.

3. **In the POS UI**: Go to Settings → Hardware → Add Device → Network Printer → IP `127.0.0.1`, Port `8000`.

## API Endpoints

All endpoints match the contract defined in `src/services/hardware/local-agent/protocol.ts`.

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/status` | Agent health check — returns version, uptime, discovered devices |
| `POST` | `/print` | Send raw bytes to a network printer via TCP |
| `POST` | `/test` | Test TCP connectivity to a printer |
| `GET` | `/discover?subnet=auto` | Scan LAN for printers on port 9100 |
| `GET` | `/usb/devices` | List connected USB devices |
| `POST` | `/usb/print` | Send raw bytes to a USB printer |

### POST /print

```json
{
  "ipAddress": "192.168.1.100",
  "port": 9100,
  "data": [27, 64, 72, 101, 108, 108, 111],
  "timeout": 5000
}
```

### POST /test

```json
{
  "ipAddress": "192.168.1.100",
  "port": 9100,
  "timeout": 3000
}
```

### POST /usb/print

```json
{
  "vendorId": 1208,
  "productId": 514,
  "data": [27, 64, 72, 101, 108, 108, 111]
}
```

## Authentication

The agent generates a shared secret on first run, saved to `~/.pos-agent-token`. All endpoints except `/status` require an `Authorization: Bearer <token>` header.

To disable auth for development:
```bash
AGENT_AUTH_DISABLED=1 npm run dev
```

## Device Discovery

The agent automatically scans the local subnet for printers on port 9100 on startup, and re-scans every 2 minutes. Discovered devices appear in `GET /status` response and in the POS UI.

## How It Works

```
Browser POS (cloud/local)
    │
    │  HTTP POST /print
    ▼
┌──────────────────────┐
│  POS Hardware Agent   │  ← this service (localhost:8043)
│  Node.js HTTP server  │
└──────┬───────────────┘
       │
       ├── Network printer: raw TCP to ip:9100
       └── USB printer: libusb via `usb` npm package
```

## Configuration

| Env Variable | Default | Description |
|---|---|---|
| `AGENT_PORT` | `8043` | Port the agent listens on |
| `AGENT_AUTH_DISABLED` | `false` | Set to `1` to skip auth (dev mode) |

## Production Deployment

For production, build and run:

```bash
npm run build
npm start
```

To run as a system service, create a systemd unit (Linux), launchd plist (macOS), or Windows service wrapper pointing to `node dist/index.js`.

## USB Support

USB printing requires the `usb` npm package which uses native bindings. If it fails to compile on your platform, the agent still works for network printers — USB routes will return a graceful error.

On Linux, you may need udev rules for USB printer access without root:

```bash
echo 'SUBSYSTEM=="usb", ATTR{idVendor}=="04b8", MODE="0666"' | sudo tee /etc/udev/rules.d/99-printer.rules
sudo udevadm control --reload-rules
```
