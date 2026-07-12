# Certificate Renderer — Self-Hosted WeasyPrint Sidecar

This container is the **PDF producer** for Certificate Engine v3. It is
owned infrastructure — you build it, you deploy it (Kubernetes,
docker-compose, bare metal — anywhere your platform already runs).
It is NOT a third-party API.

## Contract

`POST /render`
```
Headers:
  X-Signature: hex(HMAC-SHA256(body, RENDERER_SIGNING_SECRET))
  Content-Type: application/json
Body:
  { "html": "<full self-contained HTML document>" }
Response:
  200 application/pdf   ← PDF bytes
  401                   ← bad signature
  400 application/json  ← { error, detail }
```

`GET /healthz` → `200 {"status":"ok"}`

The edge function (`generate-tax-certificate`) invokes this via
`WeasyPrintProducer`. Only two env vars are needed there:
`CERT_RENDERER_URL` and `CERT_RENDERER_SIGNING_SECRET`.

## Build

```
docker build -t erp/cert-renderer:latest infra/cert-renderer/
```

## Run

```
docker run --rm -p 8080:8080 \
  -e RENDERER_SIGNING_SECRET="$(openssl rand -hex 32)" \
  erp/cert-renderer:latest
```

Set the same secret as `CERT_RENDERER_SIGNING_SECRET` in the Supabase
edge-function environment, and set `CERT_RENDERER_URL` to the
sidecar's internal URL.

## Why WeasyPrint

- First-class CSS Paged Media (`@page`, `position: running()`,
  `page-break-*`, repeated `thead`) — the exact primitives our
  compiler emits.
- Pure Python, deterministic output, no headless browser.
- ~150 MB image, cold-start < 1 s.
- No proprietary components, no cloud API, no license fee.

## Scaling

Stateless. Scale horizontally behind any load balancer. Give each
replica ~256 MB RAM. Concurrency is bounded per-worker by uvicorn
workers (`WORKERS=4` env var).
