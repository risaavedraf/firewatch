import type { IconName } from '../components/ui';

// The fourteen views of the application. The nine areas of the retired page are all
// still here: `#sources` also carries the dependent-services status and
// `#session` also carries the permissions matrix, which is the grouping the user
// chose (D1). `#pending` gained the navigation entry it never had (D2): the
// "not implemented yet" inventory is exactly the kind of honesty statement that
// must not depend on someone scrolling to the bottom of the page. `#notifications`
// is PM-08's own route: the persisted PM-07 alerts are a destination, not a
// panel hidden inside another view. `#observations` is the PM-09
// field-observation page, reachable by every role: the server decides reads and
// writes, and the page renders its answer. PM-11 adds `#infrastructure` as its
// own demo view rather than folding it into territorio. `#compare` is PM-05's
// comparator: its own route because a comparison of two or three zones is a
// different question from one zone's detail, not a panel of it. PM-03 adds
// `#simulator` as its own destination: the counterfactual recalculation is a page
// the operator opens, not a control hidden inside the territory panel, and it
// belongs to Prevención because it explains the rule that produced a zone's
// level. PM-16 adds `#status` as the single operational board of the gateway
// aggregate, the weather source and the active rule: it is a destination of its
// own, and `#sources` keeps the provenance and pipeline detail it already carries.
export type ViewId =
  | 'overview'
  | 'infrastructure'
  | 'history'
  | 'compare'
  | 'actions'
  | 'observations'
  | 'simulator'
  | 'status'
  | 'sources'
  | 'jobs'
  | 'pending'
  | 'session'
  | 'notifications'
  | 'audit';

export interface RouteDefinition {
  id: ViewId;
  hash: `#${ViewId}`;
  label: string;
  group: string;
  icon: IconName;
  // Breadcrumb and document-title copy, kept beside the route so a view cannot
  // disagree with the place the navigation says it is.
  title: string;
}

export const routes: readonly RouteDefinition[] = [
  { id: 'overview', hash: '#overview', label: 'Territorio', group: 'Prevención', icon: 'territory', title: 'Estado de la zona' },
  { id: 'infrastructure', hash: '#infrastructure', label: 'Infraestructura', group: 'Prevención', icon: 'zones', title: 'Infraestructura prioritaria' },
  { id: 'history', hash: '#history', label: 'Historial de lotes', group: 'Prevención', icon: 'history', title: 'Historial de lotes' },
  { id: 'compare', hash: '#compare', label: 'Comparador', group: 'Prevención', icon: 'zones', title: 'Comparador de zonas' },
  { id: 'actions', hash: '#actions', label: 'Acciones preventivas', group: 'Prevención', icon: 'actions', title: 'Acciones preventivas' },
  {
    id: 'observations',
    hash: '#observations',
    label: 'Observaciones de campo',
    group: 'Prevención',
    icon: 'zones',
    title: 'Observaciones de campo',
  },
  {
    id: 'simulator',
    hash: '#simulator',
    label: 'Simulador',
    group: 'Prevención',
    icon: 'refresh',
    title: 'Simulador contrafactual',
  },
  { id: 'status', hash: '#status', label: 'Estado de servicios', group: 'Información', icon: 'pipeline', title: 'Estado de servicios' },
  { id: 'sources', hash: '#sources', label: 'Fuentes y servicios', group: 'Información', icon: 'sources', title: 'Fuentes y servicios' },
  { id: 'jobs', hash: '#jobs', label: 'Procesamiento', group: 'Información', icon: 'jobs', title: 'Procesamiento asíncrono' },
  { id: 'pending', hash: '#pending', label: 'Aún no implementado', group: 'Información', icon: 'pending', title: 'Aún no implementado' },
  { id: 'session', hash: '#session', label: 'Sesión y permisos', group: 'Acceso', icon: 'session', title: 'Sesión y permisos' },
  { id: 'notifications', hash: '#notifications', label: 'Notificaciones', group: 'Coordinación', icon: 'attention', title: 'Notificaciones' },
  { id: 'audit', hash: '#audit', label: 'Registro de actividad', group: 'Coordinación', icon: 'audit', title: 'Registro de actividad' },
];

export const defaultRoute: RouteDefinition = routes[0];
export const navigationGroups: readonly string[] = [...new Set(routes.map(route => route.group))];

// Routing is hash-based on purpose. The served page is one document and the
// server deliberately has no SPA fallback, so a hash keeps every view linkable
// and reloadable without inventing a server rewrite rule; it also keeps the
// Keycloak redirect URI valid for whichever view is open.
export function routeFromHash(hash: string): RouteDefinition {
  return routes.find(route => route.hash === hash) ?? defaultRoute;
}
