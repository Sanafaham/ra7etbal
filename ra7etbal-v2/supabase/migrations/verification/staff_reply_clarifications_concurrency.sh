#!/usr/bin/env bash
# Two real sessions race on the same clarification (open and resolve).
# Requires the forward migration to be applied. Uses PG* env vars.
set -euo pipefail
PSQL=(psql -v ON_ERROR_STOP=1 -qAt)

ids=$("${PSQL[@]}" <<'SQL'
WITH o AS (INSERT INTO auth.users (id) VALUES (gen_random_uuid()) RETURNING id),
p AS (INSERT INTO public.people (id, user_id, name, phone, is_family)
      SELECT gen_random_uuid(), id, 'Christopher', '+15550000001', false FROM o RETURNING id, user_id),
t1 AS (INSERT INTO public.tasks (id, user_id, status, assigned_to) SELECT gen_random_uuid(), user_id, 'pending', 'Christopher' FROM p RETURNING id),
t2 AS (INSERT INTO public.tasks (id, user_id, status, assigned_to) SELECT gen_random_uuid(), user_id, 'pending', 'Christopher' FROM p RETURNING id),
m AS (INSERT INTO public.staff_messages (id, user_id, person_id, staff_name, staff_phone, source, inbound_text,
        classification, processing_status, next_action_owner, user_facing_state, owner_attention_required, received_at)
      SELECT gen_random_uuid(), user_id, id, 'Christopher', '+15550000001', 'whatsapp', 'Salmon is unavailable',
        'blocker', 'completed', 'owner', 'Needs You', true, now() FROM p RETURNING id)
SELECT (SELECT user_id FROM p) || ' ' || (SELECT id FROM p) || ' ' || (SELECT id FROM t1) || ' ' || (SELECT id FROM t2) || ' ' || (SELECT id FROM m);
SQL
)
read -r OWNER PERSON T1 T2 MSG <<<"$ids"

# Concurrent open: session A holds its transaction open; B must wait and get the same row.
open_sql="SELECT clarification_id || ':' || is_new FROM open_staff_reply_clarification('$MSG','$OWNER',ARRAY['$T1','$T2']::uuid[],'Which task?',1800)"
( "${PSQL[@]}" -c "BEGIN; $open_sql; SELECT pg_sleep(2); COMMIT;" | grep ':' > /tmp/src_open_a ) &
sleep 0.5
"${PSQL[@]}" -c "$open_sql" > /tmp/src_open_b
wait
A=$(cat /tmp/src_open_a); B=$(cat /tmp/src_open_b)
[[ "${A%%:*}" == "${B%%:*}" ]] || { echo "FAIL: concurrent open produced two clarifications ($A / $B)"; exit 1; }
[[ "${A#*:}" == "true" && "${B#*:}" == "false" ]] || { echo "FAIL: expected one new and one existing ($A / $B)"; exit 1; }
COUNT=$("${PSQL[@]}" -c "SELECT count(*) FROM staff_reply_clarifications WHERE staff_message_id='$MSG'")
[[ "$COUNT" == "1" ]] || { echo "FAIL: $COUNT clarifications for one message"; exit 1; }
echo "PASS: concurrent open creates exactly one clarification"

CID="${A%%:*}"
# Concurrent resolve with different answers: exactly one wins, the other is refused.
res_sql() { echo "SELECT outcome FROM resolve_staff_reply_clarification('$CID','$OWNER','$PERSON',$1,NULL)"; }
( "${PSQL[@]}" -c "BEGIN; $(res_sql 1); SELECT pg_sleep(2); COMMIT;" | grep -v '^$' | head -1 > /tmp/src_res_a ) &
sleep 0.5
"${PSQL[@]}" -c "$(res_sql 2)" > /tmp/src_res_b
wait
RA=$(cat /tmp/src_res_a); RB=$(cat /tmp/src_res_b)
[[ "$RA" == "linked" && "$RB" == "conflict" ]] || { echo "FAIL: concurrent resolve outcomes $RA / $RB"; exit 1; }
LINK=$("${PSQL[@]}" -c "SELECT task_id FROM staff_messages WHERE id='$MSG'")
[[ "$LINK" == "$T1" ]] || { echo "FAIL: message linked to $LINK, expected first winner $T1"; exit 1; }
echo "PASS: concurrent resolve has exactly one winner and the loser cannot relink"
