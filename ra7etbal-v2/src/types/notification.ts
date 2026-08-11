export interface OwnerNotification {
  id: string;
  user_id: string;
  event_key: string;
  kind: string;
  title: string;
  body: string;
  occurred_at: string;
  read_at: string | null;
  target_type: string | null;
  target_id: string | null;
  target_url: string | null;
  metadata: Record<string, unknown>;
  created_at: string;
}
