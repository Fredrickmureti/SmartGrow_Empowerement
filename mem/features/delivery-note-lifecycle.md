---
name: Delivery note lifecycle ownership
description: DN status/dates are DB-owned via atomic RPCs, client can only edit descriptive fields, numbering is business-scoped and atomic, contacts embeds need FK hints
type: feature
---
- `delivery_notes` lifecycle columns (`status`, `ready_at`, `dispatched_at`, `delivered_at`, `cancelled_at`, `spawned_invoice_id`) are not updatable by `authenticated`/`anon`; column grants allow only descriptive fields (notes, delivery_date, shipping_address, driver_name, vehicle_number, contact_id, received_by_contact_id, auto_invoice_on_complete, updated_at). Change lifecycle only through the SECURITY DEFINER engines: mark_delivery_ready_atomic, dispatch_delivery_atomic, complete_delivery_atomic, record_partial_delivery_atomic, cancel_delivery_atomic, create_invoice_from_delivery_atomic, wms_manifest_bridge_delivery_notes.
- No client DELETE on delivery notes — cancel via `cancel_delivery_atomic`.
- Create via `create_delivery_note_atomic(p_payload, p_lines, p_user_id)`; it allocates the number under an advisory lock. Never reserve numbers client-side.
- `delivery_notes` has two FKs to `contacts`: always embed as `contact:contacts!contact_id(...)` and `received_by_contact:contacts!received_by_contact_id(...)`.
- Ratchet test: `src/__tests__/architecture.delivery-note-engine.test.ts`.
