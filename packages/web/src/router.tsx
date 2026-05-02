import { lazy, Suspense } from 'react';
import {
  createBrowserRouter,
  Navigate,
  Outlet,
  RouterProvider,
  useLocation,
} from 'react-router-dom';
import { AppShell } from './components/layout/AppShell.js';
import { useBootstrap } from './bootstrap/use-bootstrap.js';
import { OnboardingRouter } from './routes/onboarding/index.js';

// Lazy-load page components so each route ships its own chunk (PRD-096).
const Dashboard = lazy(() => import('./routes/pages.js'));
const Jobs = lazy(() => import('./routes/pages.js').then((m) => ({ default: m.Jobs })));
const Applications = lazy(() =>
  import('./routes/pages.js').then((m) => ({ default: m.Applications })),
);
const ReadyToApply = lazy(() =>
  import('./routes/pages.js').then((m) => ({ default: m.ReadyToApply })),
);
const Alerts = lazy(() => import('./routes/pages.js').then((m) => ({ default: m.Alerts })));
const Chat = lazy(() => import('./routes/pages.js').then((m) => ({ default: m.Chat })));
const Profile = lazy(() => import('./routes/pages.js').then((m) => ({ default: m.Profile })));
const Settings = lazy(() => import('./routes/pages.js').then((m) => ({ default: m.Settings })));
const NotFound = lazy(() => import('./routes/pages.js').then((m) => ({ default: m.NotFound })));

function PageFallback(): JSX.Element {
  return <div className="p-6 text-sm text-ink-secondary">Loading…</div>;
}

/**
 * Gate: bootstrap must succeed before anything else renders. Once we have
 * the response, redirect to /onboarding/welcome if the daemon reports
 * onboarded=false (per PRD-093). Otherwise let the matched route render.
 */
function BootstrapGate(): JSX.Element {
  const { data, isLoading, error } = useBootstrap();
  const location = useLocation();

  if (isLoading) return <PageFallback />;
  if (error || !data) {
    return (
      <div className="flex h-screen w-screen items-center justify-center bg-surface-base p-8 text-center text-ink-primary">
        <div>
          <h1 className="font-display text-2xl font-headline tracking-tight">
            Cannot reach the Vina daemon
          </h1>
          <p className="mt-2 text-sm text-ink-secondary">
            Run <code className="font-mono">vina start</code> in your terminal and reload.
          </p>
        </div>
      </div>
    );
  }

  const onOnboarding = location.pathname.startsWith('/onboarding');
  const onDoneStep = location.pathname === '/onboarding/done';
  if (!data.onboarded && !onOnboarding) {
    // Land at /onboarding (no step) so the resume gate picks the right step
    // from server state — handles fresh DB and partially-completed setup.
    return <Navigate to="/onboarding" replace />;
  }
  if (data.onboarded && onOnboarding && !onDoneStep) {
    return <Navigate to="/" replace />;
  }

  return <Outlet />;
}

export const router = createBrowserRouter([
  {
    element: <BootstrapGate />,
    children: [
      { path: '/onboarding/*', element: <OnboardingRouter /> },
      {
        element: <AppShell />,
        children: [
          {
            index: true,
            element: (
              <Suspense fallback={<PageFallback />}>
                <Dashboard />
              </Suspense>
            ),
          },
          {
            path: '/jobs',
            element: (
              <Suspense fallback={<PageFallback />}>
                <Jobs />
              </Suspense>
            ),
          },
          {
            path: '/applications',
            element: (
              <Suspense fallback={<PageFallback />}>
                <Applications />
              </Suspense>
            ),
          },
          {
            path: '/ready',
            element: (
              <Suspense fallback={<PageFallback />}>
                <ReadyToApply />
              </Suspense>
            ),
          },
          {
            path: '/alerts',
            element: (
              <Suspense fallback={<PageFallback />}>
                <Alerts />
              </Suspense>
            ),
          },
          {
            path: '/chat',
            element: (
              <Suspense fallback={<PageFallback />}>
                <Chat />
              </Suspense>
            ),
          },
          {
            path: '/profile',
            element: (
              <Suspense fallback={<PageFallback />}>
                <Profile />
              </Suspense>
            ),
          },
          {
            path: '/settings',
            element: (
              <Suspense fallback={<PageFallback />}>
                <Settings />
              </Suspense>
            ),
          },
          {
            path: '*',
            element: (
              <Suspense fallback={<PageFallback />}>
                <NotFound />
              </Suspense>
            ),
          },
        ],
      },
    ],
  },
]);

export function AppRouter(): JSX.Element {
  return <RouterProvider router={router} />;
}
