import { lazy, Suspense, useEffect } from 'react';
import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { AppLayout } from '@/components/layout/AppLayout';
import { PageLoader } from '@/components/shared/LoadingSpinner';
import { useAuthStore } from '@/stores/auth.store';
import { applyUserLanguage } from '@/hooks/use-auth';

function AdminRoute({ children }: { children: React.ReactNode }) {
  const isAdmin = useAuthStore((s) => s.isAdmin());
  if (!isAdmin) return <Navigate to="/" replace />;
  return <>{children}</>;
}

/** The landing page: an admin's is the bots, a viewer's their account. */
function Home() {
  const isAdmin = useAuthStore((s) => s.isAdmin());
  return <Navigate to={isAdmin ? '/music-bots' : '/settings'} replace />;
}

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      retry: 1,
      refetchOnWindowFocus: false,
      staleTime: 30_000,
    },
  },
});

// Lazy-loaded pages
const Login = lazy(() => import('@/pages/Login'));
const SsoCallback = lazy(() => import('@/pages/SsoCallback'));
const MusicBots = lazy(() => import('@/pages/MusicBots'));
const MusicRequests = lazy(() => import('@/pages/MusicRequests'));
const Settings = lazy(() => import('@/pages/Settings'));
const NotFound = lazy(() => import('@/pages/NotFound'));
const SetupPage = lazy(() => import('@/pages/SetupPage'));

export function App() {
  // Apply the signed-in user's saved language on startup (cross-device safety
  // net; same-device choice is already restored from localStorage by i18n).
  useEffect(() => {
    applyUserLanguage(useAuthStore.getState().user);
  }, []);

  return (
    <QueryClientProvider client={queryClient}>
      <BrowserRouter>
        <Suspense fallback={<PageLoader />}>
          <Routes>
            <Route path="/login" element={<Login />} />
            <Route path="/login/sso" element={<SsoCallback />} />
            <Route path="/setup" element={<SetupPage />} />

            <Route element={<AppLayout />}>
              <Route path="/" element={<Home />} />
              <Route path="/music-requests" element={<AdminRoute><MusicRequests /></AdminRoute>} />
              <Route path="/music-bots" element={<AdminRoute><MusicBots /></AdminRoute>} />
              <Route path="/settings" element={<Settings />} />
              <Route path="*" element={<NotFound />} />
            </Route>
          </Routes>
        </Suspense>
      </BrowserRouter>
    </QueryClientProvider>
  );
}
