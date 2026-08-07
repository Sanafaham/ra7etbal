import { create } from "zustand";

type CallStatus = "idle" | "connecting" | "connected" | "error";
export type CarsonChannel = "voice" | "text";

interface CarsonStore {
  open: boolean;
  setOpen: (open: boolean) => void;
  callStatus: CallStatus;
  setCallStatus: (status: CallStatus) => void;
  channel: CarsonChannel;
  setChannel: (channel: CarsonChannel) => void;
  /**
   * Text queued to appear in the typed input once a text session is
   * connected (e.g. "Send to Carson" on a Note card). Consumed exactly once —
   * the widget clears it via setPendingTypedDraft(null) after inserting it,
   * so it never re-applies on a later, unrelated typed session.
   */
  pendingTypedDraft: string | null;
  setPendingTypedDraft: (draft: string | null) => void;
}

export const useCarsonStore = create<CarsonStore>((set) => ({
  open: false,
  setOpen: (open) => set({ open }),
  callStatus: "idle",
  setCallStatus: (callStatus) => set({ callStatus }),
  channel: "voice",
  setChannel: (channel) => set({ channel }),
  pendingTypedDraft: null,
  setPendingTypedDraft: (pendingTypedDraft) => set({ pendingTypedDraft }),
}));
