import { supabase } from "./supabase";
import type { OwnerNotification } from "../types/notification";

const FIELDS = "id,user_id,event_key,kind,title,body,occurred_at,read_at,target_type,target_id,target_url,metadata,created_at";

export async function listOwnerNotifications(): Promise<OwnerNotification[]> {
  const { data, error } = await supabase
    .from("owner_notifications")
    .select(FIELDS)
    .order("occurred_at", { ascending: false });
  if (error) throw error;
  return (data ?? []) as unknown as OwnerNotification[];
}

export async function markOwnerNotificationRead(id: string, readAt: string): Promise<void> {
  const { error } = await supabase
    .from("owner_notifications")
    .update({ read_at: readAt })
    .eq("id", id)
    .is("read_at", null);
  if (error) throw error;
}

export async function markAllOwnerNotificationsRead(readAt: string): Promise<void> {
  const { error } = await supabase
    .from("owner_notifications")
    .update({ read_at: readAt })
    .is("read_at", null);
  if (error) throw error;
}
