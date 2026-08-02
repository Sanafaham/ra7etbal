/**
 * A durable "pre-existing production data" fixture, inserted once, before
 * the new escalation table's lifecycle is ever exercised. Its purpose is
 * solely to prove that applying, rolling back, and reapplying
 * 20260726_staff_escalation_owner_decisions.sql never touches unrelated
 * staff_messages data — the row inserted here must be byte-for-byte
 * identical (on its pre-existing columns) after the full round trip.
 *
 * Uses fixed, literal UUIDs (not gen_random_uuid()) so later verification
 * scripts can look this exact row up by id across separate psql sessions.
 */

INSERT INTO auth.users (id, email) VALUES
  ('00000000-0000-0000-0000-0000000000aa', 'preexisting-owner@example.com')
ON CONFLICT (id) DO NOTHING;

INSERT INTO public.people (id, user_id, name, phone, is_family) VALUES
  ('00000000-0000-0000-0000-0000000000ab', '00000000-0000-0000-0000-0000000000aa', 'Grace', '+15550000099', false)
ON CONFLICT (id) DO NOTHING;

INSERT INTO public.staff_messages
  (id, user_id, person_id, staff_name, staff_phone, source,
   inbound_text, classification, processing_status, next_action_owner,
   user_facing_state, owner_attention_required, escalation_reason, received_at)
VALUES
  ('00000000-0000-0000-0000-0000000000ac', '00000000-0000-0000-0000-0000000000aa',
   '00000000-0000-0000-0000-0000000000ab', 'Grace', '+15550000099', 'whatsapp',
   'Pre-existing message that must survive the migration round trip unchanged.',
   'routine_question', 'completed', 'nobody', 'Completed', false, NULL, now())
ON CONFLICT (id) DO NOTHING;

SELECT 'pre-existing data fixture inserted' AS status,
       id, classification, user_facing_state, owner_attention_required
FROM public.staff_messages
WHERE id = '00000000-0000-0000-0000-0000000000ac';
