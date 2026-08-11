CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE SCHEMA IF NOT EXISTS auth;

CREATE TABLE auth.users (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid()
);

CREATE TABLE public.tasks (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE
);

CREATE TABLE public.whatsapp_deliveries (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  task_id uuid NULL REFERENCES public.tasks(id) ON DELETE SET NULL,
  source_type text NOT NULL CHECK (source_type IN (
    'delegation',
    'message',
    'followup',
    'routine_delegation',
    'routine_message',
    'automation_delegation',
    'automation_message',
    'image'
  )),
  message_kind text NOT NULL DEFAULT 'template',
  template_name text NULL,
  delivery_status text NOT NULL DEFAULT 'pending',
  metadata jsonb NOT NULL DEFAULT '{}'
);
