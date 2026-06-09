/** A raw captured thought — not yet processed into a task. */
export interface InboxItem {
  id: string;
  user_id: string;
  content: string;
  /** Where the item came from: 'text_carson' | 'voice_carson' | 'manual' */
  source: string;
  created_at: string;
  /** Non-null once the item has been turned into a task or dismissed. */
  processed_at: string | null;
}

export interface InboxItemDraft {
  user_id: string;
  content: string;
  source: string;
}
