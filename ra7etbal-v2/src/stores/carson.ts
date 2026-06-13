import { create } from "zustand";

type CallStatus = "idle" | "connecting" | "connected" | "error";

interface CarsonStore {
  open: boolean;
  setOpen: (open: boolean) => void;
  callStatus: CallStatus;
  setCallStatus: (status: CallStatus) => void;
}

export const useCarsonStore = create<CarsonStore>((set) => ({
  open: false,
  setOpen: (open) => set({ open }),
  callStatus: "idle",
  setCallStatus: (callStatus) => set({ callStatus }),
}));
