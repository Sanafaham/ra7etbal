INSERT INTO auth.users (id) VALUES
  ('11111111-1111-4111-8111-111111111111'),
  ('22222222-2222-4222-8222-222222222222');

-- These rows deliberately predate the restrictive policy.
INSERT INTO public.tasks (id, user_id, description, type, due_at) VALUES
  ('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', '11111111-1111-4111-8111-111111111111',
   'pre-existing reminder retained', 'reminder', '2099-01-01T00:00:00Z'),
  ('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', '11111111-1111-4111-8111-111111111111',
   'pre-existing reminder delete probe', 'reminder', '2099-01-02T00:00:00Z');
