/**
 * Real-database verification for 20261011120000_staff_reply_clarifications.sql.
 * Rerunnable: every fixture uses fresh ids. Each block RAISEs on failure.
 */

CREATE TEMP TABLE IF NOT EXISTS _src_ids (key text PRIMARY KEY, value uuid);
DELETE FROM _src_ids;

CREATE OR REPLACE FUNCTION pg_temp._src_msg(p_owner uuid, p_person uuid, p_text text)
RETURNS uuid LANGUAGE plpgsql AS $$
DECLARE v uuid := gen_random_uuid();
BEGIN
  INSERT INTO public.staff_messages
    (id, user_id, person_id, staff_name, staff_phone, source, inbound_text, classification,
     processing_status, next_action_owner, user_facing_state, owner_attention_required,
     escalation_reason, received_at)
  VALUES (v, p_owner, p_person, 'Christopher', '+15550000001', 'whatsapp', p_text, 'blocker',
          'completed', 'owner', 'Needs You', true, p_text, now());
  RETURN v;
END $$;

DO $$
DECLARE
  v_owner uuid := gen_random_uuid(); v_other uuid := gen_random_uuid();
  v_person uuid := gen_random_uuid(); v_grace uuid := gen_random_uuid();
  v_family uuid := gen_random_uuid(); v_other_person uuid := gen_random_uuid();
  v_pizza uuid := gen_random_uuid(); v_salmon uuid := gen_random_uuid();
  v_done uuid := gen_random_uuid(); v_graces uuid := gen_random_uuid();
  v_foreign uuid := gen_random_uuid();
BEGIN
  INSERT INTO auth.users (id) VALUES (v_owner), (v_other);
  INSERT INTO public.people (id, user_id, name, phone, is_family) VALUES
    (v_person, v_owner, 'Christopher', '+15550000001', false),
    (v_grace, v_owner, 'Grace', '+15550000002', false),
    (v_family, v_owner, 'Loulya', '+15550000003', true),
    (v_other_person, v_other, 'Christopher', '+15550000009', false);
  INSERT INTO public.tasks (id, user_id, status, assigned_to, description) VALUES
    (v_pizza, v_owner, 'pending', 'Christopher', 'Make a pizza for dinner'),
    (v_salmon, v_owner, 'pending', ' christopher ', 'Get salmon for dinner'),
    (v_done, v_owner, 'done', 'Christopher', 'Old finished task'),
    (v_graces, v_owner, 'pending', 'Grace', 'Buy flowers'),
    (v_foreign, v_other, 'pending', 'Christopher', 'Other owner task');
  INSERT INTO _src_ids VALUES ('owner', v_owner), ('other', v_other), ('person', v_person),
    ('grace', v_grace), ('family', v_family), ('other_person', v_other_person),
    ('pizza', v_pizza), ('salmon', v_salmon), ('done', v_done), ('graces', v_graces),
    ('foreign', v_foreign);
END $$;

-- 1. open creates once; replay returns the same row and question
DO $$
DECLARE o uuid; p uuid; pz uuid; sa uuid; m uuid; r1 record; r2 record;
BEGIN
  SELECT value INTO o FROM _src_ids WHERE key='owner';
  SELECT value INTO p FROM _src_ids WHERE key='person';
  SELECT value INTO pz FROM _src_ids WHERE key='pizza';
  SELECT value INTO sa FROM _src_ids WHERE key='salmon';
  m := pg_temp._src_msg(o, p, 'Salmon is unavailable');
  SELECT * INTO r1 FROM open_staff_reply_clarification(m, o, ARRAY[pz, sa], 'Which task? 1. pizza 2. salmon', 1800);
  IF NOT r1.is_new OR r1.status <> 'open' THEN RAISE EXCEPTION 'FAIL 1: first open should create'; END IF;
  SELECT * INTO r2 FROM open_staff_reply_clarification(m, o, ARRAY[sa], 'DIFFERENT', 1800);
  IF r2.is_new OR r2.clarification_id <> r1.clarification_id OR r2.question_text <> r1.question_text
     OR r2.candidate_task_ids <> ARRAY[pz, sa] THEN
    RAISE EXCEPTION 'FAIL 1: replay must return the original clarification unchanged';
  END IF;
  IF (SELECT count(*) FROM staff_reply_clarifications WHERE staff_message_id = m) <> 1 THEN
    RAISE EXCEPTION 'FAIL 1: exactly one clarification per staff message';
  END IF;
  INSERT INTO _src_ids VALUES ('msg1', m), ('c1', r1.clarification_id);
  RAISE NOTICE 'PASS: 1. open is idempotent under replay';
END $$;

-- 2. open refuses invalid ownership, assignee, state and family senders
DO $$
DECLARE o uuid; x uuid; p uuid; g uuid; f uuid; op uuid; pz uuid; dn uuid; gs uuid; fo uuid; m uuid; ok boolean;
BEGIN
  SELECT value INTO o FROM _src_ids WHERE key='owner';   SELECT value INTO x FROM _src_ids WHERE key='other';
  SELECT value INTO p FROM _src_ids WHERE key='person';  SELECT value INTO f FROM _src_ids WHERE key='family';
  SELECT value INTO op FROM _src_ids WHERE key='other_person';
  SELECT value INTO pz FROM _src_ids WHERE key='pizza';  SELECT value INTO dn FROM _src_ids WHERE key='done';
  SELECT value INTO gs FROM _src_ids WHERE key='graces'; SELECT value INTO fo FROM _src_ids WHERE key='foreign';

  m := pg_temp._src_msg(o, p, 'x');
  BEGIN PERFORM open_staff_reply_clarification(m, x, ARRAY[pz], 'q', 1800); ok := false;
  EXCEPTION WHEN SQLSTATE '28000' THEN ok := true; END;
  IF NOT ok THEN RAISE EXCEPTION 'FAIL 2a: another owner must not open on this message'; END IF;

  BEGIN PERFORM open_staff_reply_clarification(m, o, ARRAY[fo], 'q', 1800); ok := false;
  EXCEPTION WHEN SQLSTATE '28000' THEN ok := true; END;
  IF NOT ok THEN RAISE EXCEPTION 'FAIL 2b: a cross-owner candidate task must be refused'; END IF;

  BEGIN PERFORM open_staff_reply_clarification(m, o, ARRAY[dn], 'q', 1800); ok := false;
  EXCEPTION WHEN OTHERS THEN ok := SQLERRM = 'candidate_not_pending'; END;
  IF NOT ok THEN RAISE EXCEPTION 'FAIL 2c: a done task must not be offered'; END IF;

  BEGIN PERFORM open_staff_reply_clarification(m, o, ARRAY[gs], 'q', 1800); ok := false;
  EXCEPTION WHEN OTHERS THEN ok := SQLERRM = 'candidate_not_assigned'; END;
  IF NOT ok THEN RAISE EXCEPTION 'FAIL 2d: another staff member''s task must not be offered'; END IF;

  BEGIN PERFORM open_staff_reply_clarification(m, o, ARRAY[pz, pz], 'q', 1800); ok := false;
  EXCEPTION WHEN OTHERS THEN ok := SQLERRM = 'invalid_candidates'; END;
  IF NOT ok THEN RAISE EXCEPTION 'FAIL 2e: duplicate candidates must be refused'; END IF;

  UPDATE staff_messages SET task_id = pz WHERE id = m;
  BEGIN PERFORM open_staff_reply_clarification(m, o, ARRAY[pz], 'q', 1800); ok := false;
  EXCEPTION WHEN OTHERS THEN ok := SQLERRM = 'already_linked'; END;
  IF NOT ok THEN RAISE EXCEPTION 'FAIL 2f: an already-linked message must not be clarified'; END IF;

  -- The other owner's same-named staff member cannot be offered this owner's tasks.
  m := pg_temp._src_msg(x, op, 'y');
  BEGIN PERFORM open_staff_reply_clarification(m, x, ARRAY[pz], 'q', 1800); ok := false;
  EXCEPTION WHEN SQLSTATE '28000' THEN ok := true; END;
  IF NOT ok THEN RAISE EXCEPTION 'FAIL 2g: cross-owner isolation with a same-named staff member'; END IF;
  RAISE NOTICE 'PASS: 2. open validates owner, assignee, pending state and linkage';
END $$;

-- 3. resolve: invalid choice, link, replay, conflicting answer; tasks untouched
DO $$
DECLARE o uuid; p uuid; sa uuid; m uuid; c uuid; ans uuid; r record; d uuid; v_status_before text;
BEGIN
  SELECT value INTO o FROM _src_ids WHERE key='owner'; SELECT value INTO p FROM _src_ids WHERE key='person';
  SELECT value INTO sa FROM _src_ids WHERE key='salmon';
  SELECT value INTO m FROM _src_ids WHERE key='msg1'; SELECT value INTO c FROM _src_ids WHERE key='c1';
  INSERT INTO staff_escalation_owner_decisions (staff_message_id, user_id, task_id) VALUES (m, o, NULL) RETURNING id INTO d;
  ans := pg_temp._src_msg(o, p, '2');
  SELECT status INTO v_status_before FROM tasks WHERE id = sa;

  SELECT * INTO r FROM resolve_staff_reply_clarification(c, o, p, 5, ans);
  IF r.outcome <> 'invalid_choice' OR r.status <> 'open' THEN RAISE EXCEPTION 'FAIL 3a: out-of-range number must not resolve'; END IF;

  SELECT * INTO r FROM resolve_staff_reply_clarification(c, o, p, 2, ans);
  IF r.outcome <> 'linked' OR r.resolved_task_id <> sa THEN RAISE EXCEPTION 'FAIL 3b: answer 2 should link salmon'; END IF;
  IF (SELECT task_id FROM staff_messages WHERE id = m) IS DISTINCT FROM sa THEN
    RAISE EXCEPTION 'FAIL 3b: original staff message must now carry the salmon task';
  END IF;
  IF (SELECT task_id FROM staff_escalation_owner_decisions WHERE id = d) IS DISTINCT FROM sa THEN
    RAISE EXCEPTION 'FAIL 3b: blank owner-decision task must be filled';
  END IF;
  IF (SELECT count(*) FROM staff_escalation_owner_decisions WHERE staff_message_id = m) <> 1 THEN
    RAISE EXCEPTION 'FAIL 3b: no second owner-decision record';
  END IF;
  IF (SELECT status FROM tasks WHERE id = sa) IS DISTINCT FROM v_status_before THEN
    RAISE EXCEPTION 'FAIL 3b: resolving must never change the task status';
  END IF;
  IF (SELECT owner_notification_status FROM staff_messages WHERE id = m) <> 'not_attempted' THEN
    RAISE EXCEPTION 'FAIL 3b: resolving must not touch owner notification state';
  END IF;

  SELECT * INTO r FROM resolve_staff_reply_clarification(c, o, p, 2, ans);
  IF r.outcome <> 'already_resolved' THEN RAISE EXCEPTION 'FAIL 3c: repeated answer should be already_resolved'; END IF;
  SELECT * INTO r FROM resolve_staff_reply_clarification(c, o, p, 1, ans);
  IF r.outcome <> 'conflict' OR r.resolved_task_id <> sa THEN RAISE EXCEPTION 'FAIL 3d: a different answer must be refused'; END IF;
  SELECT * INTO r FROM resolve_staff_reply_clarification(c, o, p, 0, ans);
  IF r.outcome <> 'conflict' THEN RAISE EXCEPTION 'FAIL 3d: 0 after linking must be refused'; END IF;
  RAISE NOTICE 'PASS: 3. resolve links once, fills only blanks, never touches tasks';
END $$;

-- 4. 0 = unrelated; deadline; task changed; cross-owner / other person
DO $$
DECLARE o uuid; x uuid; p uuid; g uuid; pz uuid; sa uuid; m uuid; c uuid; r record; ok boolean;
BEGIN
  SELECT value INTO o FROM _src_ids WHERE key='owner'; SELECT value INTO x FROM _src_ids WHERE key='other';
  SELECT value INTO p FROM _src_ids WHERE key='person'; SELECT value INTO g FROM _src_ids WHERE key='grace';
  SELECT value INTO pz FROM _src_ids WHERE key='pizza'; SELECT value INTO sa FROM _src_ids WHERE key='salmon';

  m := pg_temp._src_msg(o, p, 'Running late');
  SELECT clarification_id INTO c FROM open_staff_reply_clarification(m, o, ARRAY[pz, sa], 'q', 1800);
  SELECT * INTO r FROM resolve_staff_reply_clarification(c, o, p, 0, NULL);
  IF r.outcome <> 'unrelated' OR (SELECT task_id FROM staff_messages WHERE id = m) IS NOT NULL THEN
    RAISE EXCEPTION 'FAIL 4a: 0 closes without linking';
  END IF;

  m := pg_temp._src_msg(o, p, 'late reply');
  SELECT clarification_id INTO c FROM open_staff_reply_clarification(m, o, ARRAY[pz], 'q', 1800);
  UPDATE staff_reply_clarifications SET deadline_at = now() - interval '1 second' WHERE id = c;
  SELECT * INTO r FROM resolve_staff_reply_clarification(c, o, p, 1, NULL);
  IF r.outcome <> 'expired' OR r.status <> 'open' OR (SELECT task_id FROM staff_messages WHERE id = m) IS NOT NULL THEN
    RAISE EXCEPTION 'FAIL 4b: a number after the 30-minute deadline must not link';
  END IF;

  m := pg_temp._src_msg(o, p, 'task changed');
  SELECT clarification_id INTO c FROM open_staff_reply_clarification(m, o, ARRAY[pz], 'q', 1800);
  UPDATE tasks SET status = 'done' WHERE id = pz;
  SELECT * INTO r FROM resolve_staff_reply_clarification(c, o, p, 1, NULL);
  UPDATE tasks SET status = 'pending' WHERE id = pz;
  IF r.outcome <> 'task_not_eligible' OR (SELECT task_id FROM staff_messages WHERE id = m) IS NOT NULL THEN
    RAISE EXCEPTION 'FAIL 4c: a task that is no longer pending must not be linked';
  END IF;

  BEGIN PERFORM resolve_staff_reply_clarification(c, x, p, 1, NULL); ok := false;
  EXCEPTION WHEN SQLSTATE '28000' THEN ok := true; END;
  IF NOT ok THEN RAISE EXCEPTION 'FAIL 4d: another owner must not resolve'; END IF;
  BEGIN PERFORM resolve_staff_reply_clarification(c, o, g, 1, NULL); ok := false;
  EXCEPTION WHEN SQLSTATE '28000' THEN ok := true; END;
  IF NOT ok THEN RAISE EXCEPTION 'FAIL 4e: another staff member must not resolve'; END IF;
  RAISE NOTICE 'PASS: 4. unrelated, deadline, changed task and isolation';
END $$;

-- 5. privileges: server-only
DO $$
BEGIN
  IF has_table_privilege('authenticated', 'public.staff_reply_clarifications', 'SELECT')
     OR has_table_privilege('anon', 'public.staff_reply_clarifications', 'SELECT') THEN
    RAISE EXCEPTION 'FAIL 5: clients must not read clarifications';
  END IF;
  IF has_function_privilege('authenticated', 'public.open_staff_reply_clarification(uuid,uuid,uuid[],text,integer)', 'EXECUTE')
     OR has_function_privilege('anon', 'public.open_staff_reply_clarification(uuid,uuid,uuid[],text,integer)', 'EXECUTE')
     OR has_function_privilege('authenticated', 'public.resolve_staff_reply_clarification(uuid,uuid,uuid,integer,uuid)', 'EXECUTE')
     OR has_function_privilege('anon', 'public.resolve_staff_reply_clarification(uuid,uuid,uuid,integer,uuid)', 'EXECUTE') THEN
    RAISE EXCEPTION 'FAIL 5: clients must not execute clarification functions';
  END IF;
  IF NOT has_function_privilege('service_role', 'public.resolve_staff_reply_clarification(uuid,uuid,uuid,integer,uuid)', 'EXECUTE') THEN
    RAISE EXCEPTION 'FAIL 5: service_role must execute';
  END IF;
  IF NOT (SELECT relrowsecurity FROM pg_class WHERE oid = 'public.staff_reply_clarifications'::regclass) THEN
    RAISE EXCEPTION 'FAIL 5: RLS must be enabled';
  END IF;
  RAISE NOTICE 'PASS: 5. server-only privileges and RLS';
END $$;

-- 6. Owner decision: linked clarifications are disposable operational rows.
-- Task deletion must not delete the independently retained conversation/decision.
DO $$
DECLARE
  o uuid; x uuid; p uuid; op uuid; t uuid; u uuid; foreign_t uuid;
  m uuid; answer_m uuid; keep_m uuid; foreign_m uuid; c uuid; keep_c uuid; foreign_c uuid; d uuid;
  msg_before jsonb; answer_before jsonb; decision_before jsonb; unrelated_before jsonb;
BEGIN
  SELECT value INTO o FROM _src_ids WHERE key='owner';
  SELECT value INTO x FROM _src_ids WHERE key='other';
  SELECT value INTO p FROM _src_ids WHERE key='person';
  SELECT value INTO op FROM _src_ids WHERE key='other_person';
  INSERT INTO tasks(user_id,status,assigned_to,description) VALUES(o,'pending','Christopher','Delete this synthetic task') RETURNING id INTO t;
  INSERT INTO tasks(user_id,status,assigned_to,description) VALUES(o,'pending','Christopher','Keep this synthetic task') RETURNING id INTO u;
  INSERT INTO tasks(user_id,status,assigned_to,description) VALUES(x,'pending','Christopher','Other tenant task') RETURNING id INTO foreign_t;
  m := pg_temp._src_msg(o,p,'Original incident retained');
  answer_m := pg_temp._src_msg(o,p,'1');
  keep_m := pg_temp._src_msg(o,p,'Unrelated incident retained');
  foreign_m := pg_temp._src_msg(x,op,'Other tenant incident retained');
  UPDATE staff_messages SET carson_response='Which task? 1. deleted task' WHERE id=m;
  INSERT INTO staff_escalation_owner_decisions(staff_message_id,user_id,task_id) VALUES(m,o,NULL) RETURNING id INTO d;
  SELECT clarification_id INTO c FROM open_staff_reply_clarification(m,o,ARRAY[t],'Which task? 1. deleted task',1800);
  PERFORM resolve_staff_reply_clarification(c,o,p,1,answer_m);
  SELECT clarification_id INTO keep_c FROM open_staff_reply_clarification(keep_m,o,ARRAY[u],'Keep question',1800);
  PERFORM resolve_staff_reply_clarification(keep_c,o,p,1,NULL);
  SELECT clarification_id INTO foreign_c FROM open_staff_reply_clarification(foreign_m,x,ARRAY[foreign_t],'Other tenant question',1800);
  PERFORM resolve_staff_reply_clarification(foreign_c,x,op,1,NULL);
  SELECT to_jsonb(sm)-'task_id'-'updated_at' INTO msg_before FROM staff_messages sm WHERE id=m;
  SELECT to_jsonb(sm) INTO answer_before FROM staff_messages sm WHERE id=answer_m;
  SELECT to_jsonb(sd)-'task_id'-'updated_at' INTO decision_before FROM staff_escalation_owner_decisions sd WHERE id=d;
  SELECT jsonb_agg(to_jsonb(sc) ORDER BY sc.id) INTO unrelated_before FROM staff_reply_clarifications sc WHERE id IN(keep_c,foreign_c);

  DELETE FROM tasks WHERE id=t;
  IF EXISTS(SELECT 1 FROM tasks WHERE id=t) OR EXISTS(SELECT 1 FROM staff_reply_clarifications WHERE id=c) THEN
    RAISE EXCEPTION 'FAIL 6: deleted task or linked clarification survived';
  END IF;
  IF (SELECT count(*) FROM tasks WHERE id IN(u,foreign_t))<>2
     OR (SELECT jsonb_agg(to_jsonb(sc) ORDER BY sc.id) FROM staff_reply_clarifications sc WHERE id IN(keep_c,foreign_c)) IS DISTINCT FROM unrelated_before THEN
    RAISE EXCEPTION 'FAIL 6: unrelated same-owner or foreign-owner records changed';
  END IF;
  IF (SELECT to_jsonb(sm)-'task_id'-'updated_at' FROM staff_messages sm WHERE id=m) IS DISTINCT FROM msg_before
     OR (SELECT task_id FROM staff_messages WHERE id=m) IS NOT NULL
     OR (SELECT to_jsonb(sm) FROM staff_messages sm WHERE id=answer_m) IS DISTINCT FROM answer_before
     OR (SELECT to_jsonb(sd)-'task_id'-'updated_at' FROM staff_escalation_owner_decisions sd WHERE id=d) IS DISTINCT FROM decision_before
     OR (SELECT task_id FROM staff_escalation_owner_decisions WHERE id=d) IS NOT NULL THEN
    RAISE EXCEPTION 'FAIL 6: retained original/answer/owner-decision history changed beyond existing task-FK cleanup';
  END IF;
  IF EXISTS(SELECT 1 FROM pg_trigger WHERE tgrelid='public.staff_reply_clarifications'::regclass AND NOT tgisinternal) THEN
    RAISE EXCEPTION 'FAIL 6: unexpected clarification trigger could create a side effect';
  END IF;
  RAISE NOTICE 'PASS: 6. task deletion cascades only linked clarifications; unrelated records and retained history preserved';
END $$;

SELECT 'staff reply clarification verification complete' AS status;
