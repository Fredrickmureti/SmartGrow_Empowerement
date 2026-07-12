"""
Certificate Renderer sidecar — self-hosted paged-media PDF producer.

Owned infrastructure for Certificate Engine v3. The edge function
`generate-tax-certificate` compiles a template to a self-contained HTML
document, then POSTs the HTML here for rasterisation to PDF via
WeasyPrint (CSS Paged Media).

Auth: HMAC-SHA256 of the raw request body, hex-encoded, in
`X-Signature`. Signing secret is shared between this service and the
edge function via `RENDERER_SIGNING_SECRET`.

The service is stateless and country-agnostic — it knows nothing about
P9 or any statutory form.
"""

from __future__ import annotations

import hashlib
import hmac
import io
import logging
import os

from fastapi import FastAPI, HTTPException, Request, Response
from weasyprint import HTML

logging.basicConfig(level=logging.INFO)
log = logging.getLogger("cert-renderer")

SIGNING_SECRET = os.environ.get("RENDERER_SIGNING_SECRET", "").encode("utf-8")
if not SIGNING_SECRET:
    log.warning(
        "RENDERER_SIGNING_SECRET is not set — every request will be rejected."
    )

app = FastAPI(title="Certificate Renderer", version="1.0.0")


@app.get("/healthz")
def healthz() -> dict[str, str]:
    return {"status": "ok"}


def _verify(request_body: bytes, signature: str | None) -> None:
    if not SIGNING_SECRET:
        raise HTTPException(status_code=503, detail="renderer signing secret not configured")
    if not signature:
        raise HTTPException(status_code=401, detail="missing X-Signature")
    expected = hmac.new(SIGNING_SECRET, request_body, hashlib.sha256).hexdigest()
    if not hmac.compare_digest(expected, signature):
        raise HTTPException(status_code=401, detail="bad signature")


@app.post("/render")
async def render(request: Request) -> Response:
    body = await request.body()
    _verify(body, request.headers.get("X-Signature"))

    try:
        import json
        payload = json.loads(body)
    except Exception as exc:
        raise HTTPException(status_code=400, detail=f"invalid JSON: {exc}") from exc

    html_str = payload.get("html")
    if not isinstance(html_str, str) or not html_str:
        raise HTTPException(status_code=400, detail="missing 'html'")

    try:
        buf = io.BytesIO()
        HTML(string=html_str).write_pdf(target=buf)
        return Response(content=buf.getvalue(), media_type="application/pdf")
    except Exception as exc:
        log.exception("weasyprint render failed")
        raise HTTPException(status_code=500, detail=f"render failed: {exc}") from exc
