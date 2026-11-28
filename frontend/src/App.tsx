import { useEffect, type ReactElement } from 'react';

import { useSessionState } from './app/store';
import { useHashRoute } from './app/useHashRoute';
import { Shell } from './components/Shell';
import type { ViewId } from './app/routes';
import { ActionsView } from './views/ActionsView';
import { AuditView } from './views/AuditView';
import { AuthView } from './views/AuthView';
import { CompareView } from './views/CompareView';
import { ExecutiveView } from './views/ExecutiveView';
import { HistoryView } from './views/HistoryView';
import { InfrastructureView } from './views/InfrastructureView';
import { JobsView } from './views/JobsView';
import { NotificationsView } from './views/NotificationsView';
import { ObservationsView } from './views/ObservationsView';
import { OverviewView } from './views/OverviewView';
import { PendingView } from './views/PendingView';
import { SessionView } from './views/SessionView';
import { SimulatorView } from './views/SimulatorView';
import { SourcesView } from './views/SourcesView';
import { StatusView } from './views/StatusView';

const views: Record<ViewId, () => ReactElement> = {
  overview: OverviewView,
  executive: ExecutiveView,
  infrastructure: InfrastructureView,
  history: HistoryView,
  compare: CompareView,
  actions: ActionsView,
  observations: ObservationsView,
  simulator: SimulatorView,
  status: StatusView,
  sources: SourcesView,
  jobs: JobsView,
  session: SessionView,
  notifications: NotificationsView,
  pending: PendingView,
  audit: AuditView,
};

// Every route the workspace reads needs a bearer, so without a session the
// workspace has nothing true to show. The sign-in screen stands in for it until
// the session is established, and comes back the moment it ends — a logout, a
// refused callback or a 401 for the token the page held.
//
// This is a presentation gate, not an authorization boundary: it asks only
// whether there is a token, never which role it declares. The server still
// decides every permission.
export function App() {
  const session = useSessionState();
  return session.status === 'signed-in' ? <Workspace /> : <AuthView />;
}

// The router lives below the gate on purpose: while the sign-in screen is shown no
// workspace route is resolved, so its `#registro` hash is not normalised away.
function Workspace() {
  const route = useHashRoute();

  useEffect(() => {
    document.title = `${route.title} | FireWatch`;
  }, [route.title]);

  const View = views[route.id];

  return (
    <Shell route={route}>
      <View />
    </Shell>
  );
}
