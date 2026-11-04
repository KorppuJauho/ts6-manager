import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import { queryClient } from '@/lib/query-client';

interface UserInfo {
  id: number;
  username: string;
  displayName: string;
  role: 'admin' | 'viewer';
}

interface AuthStore {
  accessToken: string | null;
  refreshToken: string | null;
  user: UserInfo | null;
  setAuth: (accessToken: string, refreshToken: string, user: UserInfo) => void;
  setTokens: (accessToken: string, refreshToken: string) => void;
  /** Correct the stored identity without touching tokens (see AppLayout). */
  setUser: (user: UserInfo) => void;
  logout: () => void;
  isAuthenticated: () => boolean;
  isAdmin: () => boolean;
}

// M9: Tokens stored in localStorage. This is an accepted tradeoff — no XSS vectors
// exist in the frontend (no dangerouslySetInnerHTML, no eval). If XSS is introduced,
// consider moving to httpOnly cookies or in-memory storage.
export const useAuthStore = create<AuthStore>()(
  persist(
    (set, get) => ({
      accessToken: null,
      refreshToken: null,
      user: null,
      // A new identity must not see the previous one's cached queries: an
      // admin's ['me'] read back for a viewer would hand them the admin UI,
      // and the music pages would show the previous user's servers.
      setAuth: (accessToken, refreshToken, user) => {
        queryClient.clear();
        set({ accessToken, refreshToken, user });
      },
      setTokens: (accessToken, refreshToken) =>
        set({ accessToken, refreshToken }),
      setUser: (user) => set({ user }),
      logout: () => {
        queryClient.clear();
        set({ accessToken: null, refreshToken: null, user: null });
      },
      isAuthenticated: () => !!get().accessToken,
      isAdmin: () => get().user?.role === 'admin',
    }),
    { name: 'ts6-auth' },
  ),
);
