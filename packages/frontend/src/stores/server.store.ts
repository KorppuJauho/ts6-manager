import { create } from 'zustand';
import { persist } from 'zustand/middleware';

interface ServerStore {
  selectedConfigId: number | null;
  setServer: (configId: number) => void;
  clearServer: () => void;
}

export const useServerStore = create<ServerStore>()(
  persist(
    (set) => ({
      selectedConfigId: null,
      setServer: (configId) => set({ selectedConfigId: configId }),
      clearServer: () => set({ selectedConfigId: null }),
    }),
    { name: 'ts6-server' },
  ),
);
