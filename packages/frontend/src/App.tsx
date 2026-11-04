import { lazy, Suspense } from 'react';
import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { AppLayout } from '@/components/layout/AppLayout';
import { PageLoader } from '@/components/shared/LoadingSpinner';
import { useAuthStore } from '@/stores/auth.store';

function AdminRoute({ children }: { children: React.ReactNode }) {
  const isAdmin = useAuthStore((s) => s.isAdmin());
  if (!isAdmin) return <Navigate to="/" replace />;
  return <>{children}</>;
}

/** The landing page: an admin's is the bots, a viewer's the music requests. */
function Home() {
  const isAdmin = useAuthStore((s) => s.isAdmin());
  return <Navigate to={isAdmin ? '/music-bots' : '/music-requests'} replace />;
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
const MusicBots = lazy(() => import('@/pages/MusicBots'));
const MusicRequests = lazy(() => import('@/pages/MusicRequests'));
const Settings = lazy(() => import('@/pages/Settings'));
const NotFound = lazy(() => import('@/pages/NotFound'));
const SetupPage = lazy(() => import('@/pages/SetupPage'));

export function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <BrowserRouter>
        <Suspense fallback={<PageLoader />}>
          <Routes>
            <Route path="/login" element={<Login />} />
            <Route path="/setup" element={<SetupPage />} />

            <Route element={<AppLayout />}>
              <Route path="/" element={<Home />} />
              <Route path="/music-requests" element={<MusicRequests />} />
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
