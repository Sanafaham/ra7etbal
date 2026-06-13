import { create } from "zustand";

interface CarsonStore {
  open: boolean;
  setOpen: (open: boolean) => void;
}

export const useCarsonStore = create<CarsonStore>((set) => ({
  open: false,
  setOpen: (open) => set({ open }),
}));
