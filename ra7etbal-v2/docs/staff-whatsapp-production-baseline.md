# Staff WhatsApp production baseline

Verified production behavior: an opted-in, verified staff member's WhatsApp message is authenticated by Meta, resolved to the correct household and staff person, processed by the existing `processStaffMessage()` engine, answered once by Carson, and delivered through durable response-delivery leasing without duplicate replies. Production verification passed on 2026-07-24 at `https://www.ra7etbal.com`.

Migration: `supabase/migrations/20260724_staff_message_response_delivery.sql` (rollback preserved alongside it).

Verified commits:

- `6e6c4939ba6630da2f846ed8b13b40856f24a7b4` — live staff WhatsApp transport
- `3e5934f2d7d2b28701597fd275a918ad6efd8c38` — production composite-RPC response fix

Baseline rules:

- Staff WhatsApp must continue using the existing `processStaffMessage()` engine.
- No ElevenLabs bridge or second Carson may replace this path without an explicit product decision and focused regression verification.
