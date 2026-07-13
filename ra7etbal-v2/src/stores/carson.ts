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
}

export const useCarsonStore = create<CarsonStore>((set) => ({
  open: false,
  setOpen: (open) => set({ open }),
  callStatus: "idle",
  setCallStatus: (callStatus) => set({ callStatus }),
  channel: "voice",
  setChannel: (channel) => set({ channel }),
}));
