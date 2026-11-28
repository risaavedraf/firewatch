import { PanelHeading, StatusCopy, TableWrap } from '../components/ui';
import {
  OperationsStateList,
  OperationsSteps,
  OperationsViewHead,
} from '../components/operations/OperationsPrimitives';
import { rejectedSessionCopy } from '../app/sessionCopy';
import { useSessionState } from '../app/store';
import { accountConsoleURL, startLogin, type SessionState } from '../core/session';
import { effectiveRole, roleLabel } from '../domain/roles';
import '../styles/operations-workspace.css';

// N8b — the session + permissions view (S13/S17). It carries two clearly
// separated things and nothing else:
//
//   1. the Keycloak sign-in control, with the honest note that the access token
//      lives in memory only — no token is persisted and no cookie is sent;
//   2. a documentation matrix of which REAL role may do what, cited guard by
//      guard as `ruta#token` from the server's own code — the path plus the route
//      or expression that guard carries, never a line number — plus the role this
//      session's token DECLARES.
//
// The retired mockup let the operator PICK a role. That selector is deliberately
// NOT ported: a page cannot grant a permission, so a selector would be a false
// authorization boundary. There is no role selector, switcher or picker anywhere
// in this view, and the decoded role never gates, hides, allows or alters a
// single request or panel — the server, which verifies the signature, is the only
// authority. The page decodes the payload WITHOUT verifying its signature and
// says so on screen.

export type PermissionRow = {
  readonly capability: string;
  // The verdict for a request that carries NO credential. Every route in this
  // matrix is authenticated except the liveness probe, so the answer is the same
  // `401 unauthorized` almost everywhere; the default below states it once instead
  // of repeating it in every row, and a row that answers something else says so.
  readonly anonymous?: string;
  readonly viewer: string;
  readonly analista: string;
  readonly admin: string;
  readonly guards: readonly string[];
  readonly note?: string;
};

// The default "Sin token" answer: the route is inside the bearer gate, so a
// request without a credential is refused before any role is considered.
const ANONYMOUS_UNAUTHORIZED = 'No: 401 unauthorized';

// The matrix is exported so the test pins the rendered rows to the same table and
// re-reads each cited guard from disk instead of trusting a copy. The
// react-refresh rule wants a view module to export components only; this is a
// read-only documentation table, not a fast-refresh boundary, so its advisory is
// suppressed here on purpose, exactly as `PendingView` does.
//
// The guards were read from the repository and are cited as `path#token`: the
// path plus the route string, role literal or expression each guard carries. No
// citation holds a line number, so inserting a line in a backend file cannot
// invalidate one:
//   backend/services/risk/internal/handler/security.go#"viewer" is the guard that
//     admits "viewer" OR "admin" (the test pins the full comparison);
//     #fail(w, 403, "forbidden") answers any other role with 403 (an
//     unverifiable token is 401 instead).
//   backend/services/risk/internal/handler/api.go#Authorize(verifier, mux)
//     wraps the whole risk mux.
//   backend/services/jobs/internal/handler/security.go#"admin" accepts ONLY
//     "admin"; #fail(w, 403, "forbidden") answers a verified viewer with 403.
//   backend/services/jobs/internal/handler/api.go#Authorize(verifier, mux)
//     wraps the whole jobs mux: jobs status, job creation, job read and /v1/audit.
//   backend/services/gateway/internal/handler/gateway.go#/v1/audit only proxies
//     /v1/audit and adds no role of its own; #health/ready answers /health/ready
//     before any bearer check; #strings.Fields and
//     #verifier.Verify(ctx, auth[1]) require a verifiable bearer with a subject
//     but decide no role.
// eslint-disable-next-line react-refresh/only-export-components
export const PERMISSION_MATRIX: readonly PermissionRow[] = [
  {
    capability: 'Disponibilidad del gateway · GET /health/ready',
    anonymous: 'Sí: responde 204 sin comprobar token ni rol',
    viewer: 'Sí: responde 204 sin comprobar token ni rol',
    analista: 'Sí: responde 204 sin comprobar token ni rol',
    admin: 'Sí: responde 204 sin comprobar token ni rol',
    guards: ['backend/services/gateway/internal/handler/gateway.go#health/ready'],
  },
  {
    capability: 'Autenticación de cualquier ruta /v1/* · bearer verificado en el gateway',
    viewer: 'Sí: exige un bearer verificable con sujeto; no decide ningún rol',
    analista: 'Sí: exige un bearer verificable con sujeto; no decide ningún rol',
    admin: 'Sí: exige un bearer verificable con sujeto; no decide ningún rol',
    guards: [
      'backend/services/gateway/internal/handler/gateway.go#strings.Fields',
      'backend/services/gateway/internal/handler/gateway.go#verifier.Verify(ctx, auth[1])',
    ],
  },
  {
    capability: 'Consultar el estado del servicio de riesgo · GET /v1/risk/status',
    viewer: 'Sí',
    analista: 'Sí',
    admin: 'Sí',
    guards: [
      'backend/services/risk/internal/handler/api.go#GET /v1/risk/status',
      'backend/services/risk/internal/handler/security.go#"viewer"',
      'backend/services/risk/internal/handler/api.go#Authorize(verifier, mux)',
    ],
  },
  {
    capability: 'Consultar el último lote de una zona · GET /v1/risk/latest',
    viewer: 'Sí',
    analista: 'Sí',
    admin: 'Sí',
    guards: [
      'backend/services/risk/internal/handler/api.go#GET /v1/risk/latest',
      'backend/services/risk/internal/handler/security.go#"viewer"',
    ],
  },
  {
    capability:
      'Consultar el último lote de todas las zonas · GET /v1/risk/batches (la lectura agregada que pinta el mapa al cargar)',
    viewer: 'Sí',
    analista: 'Sí',
    admin: 'Sí',
    guards: [
      'backend/services/risk/internal/handler/api.go#GET /v1/risk/batches',
      'backend/services/risk/internal/handler/security.go#"viewer"',
    ],
  },
  {
    capability: 'Consultar el historial de una zona · GET /v1/risk/history',
    viewer: 'Sí',
    analista: 'Sí',
    admin: 'Sí',
    guards: [
      'backend/services/risk/internal/handler/api.go#GET /v1/risk/history',
      'backend/services/risk/internal/handler/security.go#"viewer"',
    ],
  },
  {
    capability: 'Consultar el catálogo de zonas · GET /v1/risk/zones',
    viewer: 'Sí',
    analista: 'Sí',
    admin: 'Sí',
    guards: [
      'backend/services/risk/internal/handler/api.go#GET /v1/risk/zones',
      'backend/services/risk/internal/handler/security.go#"viewer"',
    ],
  },
  {
    capability: 'Consultar los escenarios sintéticos · GET /v1/risk/synthetic-scenarios',
    viewer: 'Sí',
    analista: 'Sí',
    admin: 'Sí',
    guards: [
      'backend/services/risk/internal/handler/api.go#GET /v1/risk/synthetic-scenarios',
      'backend/services/risk/internal/handler/security.go#"viewer"',
    ],
  },
  {
    capability: 'Consultar la procedencia geográfica · GET /v1/risk/sources',
    viewer: 'Sí',
    analista: 'Sí',
    admin: 'Sí',
    guards: [
      'backend/services/risk/internal/handler/api.go#GET /v1/risk/sources',
      'backend/services/risk/internal/handler/security.go#"viewer"',
    ],
  },
  {
    capability:
      'Marcar una alerta como leída o descartada · PUT /v1/risk/alerts/{id}/state (marca personal del propio sujeto verificado)',
    viewer: 'Sí: es una preferencia del propio sujeto, no una acción administrativa',
    analista: 'Sí: es una preferencia del propio sujeto, no una acción administrativa',
    admin: 'Sí: es una preferencia del propio sujeto, no una acción administrativa',
    guards: [
      'backend/services/risk/internal/handler/api.go#PUT /v1/risk/alerts/{id}/state',
      'backend/services/risk/internal/handler/security.go#"viewer"',
    ],
  },
  {
    capability: 'Disparar una evaluación completa del ciclo · POST /v1/risk/cycle/run',
    viewer: 'No: 403 forbidden',
    analista: 'Sí: operación táctica',
    admin: 'Sí',
    guards: [
      'backend/services/risk/internal/handler/api.go#POST /v1/risk/cycle/run',
      'backend/services/risk/internal/handler/security.go#requireTactical',
    ],
  },
  {
    capability: 'Solicitar un lote sintético · POST /v1/jobs',
    viewer: 'No: 403 forbidden',
    analista: 'Sí: operación táctica',
    admin: 'Sí',
    guards: [
      'backend/services/jobs/internal/handler/api.go#POST /v1/jobs',
      'backend/services/jobs/internal/handler/security.go#holdsTacticalRole',
      'backend/services/jobs/internal/handler/api.go#Authorize(verifier, mux)',
    ],
  },
  {
    capability: 'Consultar un trabajo · GET /v1/jobs/{id}',
    viewer: 'Sí',
    analista: 'Sí',
    admin: 'Sí',
    guards: [
      'backend/services/jobs/internal/handler/api.go#GET /v1/jobs/{id}',
      'backend/services/jobs/internal/handler/security.go#holdsDeclaredRole',
    ],
  },
  {
    capability: 'Consultar el estado del servicio de trabajos · GET /v1/jobs/status',
    viewer: 'Sí',
    analista: 'Sí',
    admin: 'Sí',
    guards: [
      'backend/services/jobs/internal/handler/api.go#GET /v1/jobs/status',
      'backend/services/jobs/internal/handler/security.go#holdsDeclaredRole',
    ],
  },
  {
    capability: 'Consultar el registro de actividad · GET /v1/audit',
    viewer: 'Sí',
    analista: 'Sí',
    admin: 'Sí',
    guards: [
      'backend/services/jobs/internal/handler/api.go#GET /v1/audit',
      'backend/services/jobs/internal/handler/security.go#holdsDeclaredRole',
      'backend/services/gateway/internal/handler/gateway.go#/v1/audit',
    ],
  },
  {
    capability: 'Consultar el directorio de usuarios del realm · GET /v1/users',
    viewer: 'Sí',
    analista: 'Sí',
    admin: 'Sí',
    guards: [
      'backend/services/prevention/internal/handler/api.go#GET /v1/users',
      'backend/services/prevention/internal/handler/security.go#holdsAnyAcceptedRole',
    ],
  },
  {
    capability: 'Listar acciones preventivas · GET /v1/prevention/actions',
    viewer: 'Sí',
    analista: 'Sí',
    admin: 'Sí',
    guards: [
      'backend/services/prevention/internal/handler/api.go#GET /v1/prevention/actions',
      'backend/services/prevention/internal/handler/security.go#holdsAnyAcceptedRole',
    ],
  },
  {
    capability: 'Crear o asignar una acción preventiva · POST /v1/prevention/actions',
    viewer: 'No: 403 forbidden',
    analista: 'Sí: operación táctica',
    admin: 'Sí',
    guards: [
      'backend/services/prevention/internal/handler/api.go#POST /v1/prevention/actions',
      'backend/services/prevention/internal/handler/security.go#isAnalystOrAdmin',
    ],
  },
  {
    capability:
      'Avanzar el flujo táctico de una acción · POST /v1/prevention/actions/{id}/transitions (propuesta → asignada, asignada → en_curso, en_curso → enviada, en_curso → bloqueada, bloqueada → en_curso y devuelta → en_curso, que reabre una acción devuelta)',
    viewer: 'No: 403 forbidden',
    analista: 'Sí: operación táctica',
    admin: 'Sí',
    guards: [
      'backend/services/prevention/internal/handler/api.go#POST /v1/prevention/actions/{id}/transitions',
      'backend/services/prevention/internal/handler/security.go#isAnalystOrAdmin',
    ],
  },
  {
    capability:
      'Aprobar o rechazar la revisión final de evidencia y cancelar la acción · enviada → aceptada, enviada → devuelta y cualquier transición a cancelada (por ejemplo en_curso → cancelada)',
    viewer: 'No: 403 forbidden',
    analista: 'No: 403 forbidden, decidido antes de escribir',
    admin: 'Sí',
    guards: [
      'backend/services/prevention/internal/handler/api.go#isFinalReviewTarget',
      'backend/services/prevention/internal/handler/security.go#isAdmin',
    ],
  },
  {
    capability: 'Subir evidencia a una acción · POST /v1/prevention/actions/{id}/evidence',
    viewer: 'No: 403 forbidden',
    analista: 'Sí: operación táctica',
    admin: 'Sí',
    guards: [
      'backend/services/prevention/internal/handler/evidence.go#POST /v1/prevention/actions/{id}/evidence',
      'backend/services/prevention/internal/handler/security.go#isAnalystOrAdmin',
    ],
  },
  {
    capability:
      'Decidir sobre la evidencia vigente · POST /v1/prevention/actions/{id}/evidence/{evidence_id}/reviews',
    viewer: 'No: 403 forbidden',
    analista: 'No: 403 forbidden, decidido antes de escribir',
    admin: 'Sí',
    guards: [
      'backend/services/prevention/internal/handler/evidence.go#POST /v1/prevention/actions/{id}/evidence/{evidence_id}/reviews',
      'backend/services/prevention/internal/handler/security.go#isAdmin',
    ],
  },
  {
    capability: 'Registrar una observación de campo · POST /v1/prevention/observations',
    viewer: 'No: 403 forbidden',
    analista: 'Sí: operación táctica',
    admin: 'Sí',
    guards: [
      'backend/services/prevention/internal/handler/observations.go#POST /v1/prevention/observations',
      'backend/services/prevention/internal/handler/security.go#isAnalystOrAdmin',
    ],
  },
  {
    capability: 'Adoptar una observación en una acción · POST /v1/prevention/observations/{id}/adoption',
    viewer: 'No: 403 forbidden',
    analista: 'Sí: operación táctica',
    admin: 'Sí',
    guards: [
      'backend/services/prevention/internal/handler/observations.go#POST /v1/prevention/observations/{id}/adoption',
      'backend/services/prevention/internal/handler/security.go#isAnalystOrAdmin',
    ],
  },
  {
    capability: 'Presentar un cuarto rol · cualquier valor fuera de viewer, analista y admin',
    anonymous: 'No: 401 unauthorized; el 403 de esta fila aplica a un token verificado con un rol que el reino no declara',
    viewer: 'No: 403 forbidden',
    analista: 'No: 403 forbidden',
    admin: 'No: 403 forbidden',
    guards: [
      'backend/services/risk/internal/handler/security.go#fail(w, 403, "forbidden")',
      'backend/services/jobs/internal/handler/security.go#fail(w, 403, "forbidden")',
    ],
  },
  {
    capability: 'Rol efectivo que el proveedor de identidad entrega en el token',
    anonymous: 'No verificado: sin un token emitido por el reino no hay rol que leer ni guarda que consultar',
    viewer: 'No verificado: depende de la configuración del reino y ningún endpoint lo informa',
    analista: 'No verificado: depende de la configuración del reino y ningún endpoint lo informa',
    admin: 'No verificado: depende de la configuración del reino y ningún endpoint lo informa',
    guards: [],
    note: 'No verificado · no hay ruta ni guarda del servidor que consultar; la página solo muestra lo que el token declare',
  },
];

interface RoleDisplay {
  badge: string;
  value: string;
  // The single role the token effectively holds, in the ratified precedence
  // `admin > analista > viewer`, or an explicit "not informed" state. Never a
  // guess: the page does not upgrade an unknown role into a permission.
  effective: string;
  status: string;
}

// The role shown is the one the access token declares, or an explicit
// "unavailable" state. There is no default, no fallback and no inference: an
// absent, unreadable or role-less token is never turned into a guessed role.
function roleDisplay(session: SessionState): RoleDisplay {
  if (session.status !== 'signed-in') {
    return {
      badge: 'SIN SESIÓN',
      value: 'No disponible',
      effective: 'No disponible',
      // The panel whose subject is the session names why there is none. A refused
      // token is not a first visit, so it says so and keeps the way back (S2).
      status:
        session.reason === 'rejected'
          ? `${rejectedSessionCopy()} El rol declarado por la sesión no está disponible hasta que haya una sesión establecida.`
          : 'Sin token en memoria: el rol declarado por la sesión no está disponible; conecta una sesión para leerlo.',
    };
  }
  if (session.roles === null) {
    return {
      badge: 'NO INFORMADO',
      value: 'No informado',
      effective: 'No informado',
      status:
        'El token de acceso no declara realm_access.roles utilizables (el claim falta, no es un arreglo o viene vacío); el rol de la sesión no está informado y la página no supone ninguno.',
    };
  }
  const roles = session.roles.join(', ');
  // Membership decides, never the order of the claim: the realm grants its admin
  // account both roles in an order this page does not own.
  const effective = effectiveRole(session.roles);
  return {
    badge: 'TOKEN LEÍDO',
    value: roles,
    effective: effective === null ? 'No informado' : roleLabel(effective),
    status: `El payload del token declara los roles ${roles}. La página decodifica el payload sin verificar la firma: es un dato informativo del token, no una autorización, y el servidor, que sí verifica la firma, sigue siendo la única autoridad. El rol efectivo se deriva por pertenencia con la precedencia admin > analista > viewer, nunca por el orden de la lista.`,
  };
}

export function SessionView() {
  const session = useSessionState();
  const role = roleDisplay(session);
  const signedIn = session.status === 'signed-in';
  const authStatus =
    signedIn
      ? 'Sesión lista. Las acciones autorizadas se validan en el servidor.'
      : session.status === 'signing-in'
        ? 'Iniciando el acceso seguro a Keycloak…'
        : '';

  return (
    <section className="view" id="session" data-view="session" aria-labelledby="session-title">
      {/* Board 17's head: what the session declares, what the server decides and
          what this page cannot change. The chips state the scope, not a role. */}
      <OperationsViewHead
        id="session-head"
        eyebrow="ACCESO A LA API"
        title="Sesión y permisos"
        titleId="session-title"
        lede="Lo que la sesión declara, lo que el servidor decide y lo que esta página no puede cambiar. La matriz documenta las guardas reales; el rol mostrado es un dato del token, no una autorización."
      >
        <span className="ops-chip">Solo lectura</span>
        <span className="ops-chip">Sesión observada por el servidor</span>
      </OperationsViewHead>

      <div className="ops-layout">
        <div className="ops-stack">
          <section
            className="panel access-panel permissions-panel"
            id="permissions"
            aria-labelledby="permissions-title"
          >
            <PanelHeading
              eyebrow="COORDINACIÓN"
              title="Perfiles y permisos"
              titleId="permissions-title"
              badge={
                <span className="neutral-tag" id="session-roles-badge">
                  {role.badge}
                </span>
              }
            />
            <StatusCopy id="session-roles-status">{role.status}</StatusCopy>
            <dl className="data-list compact">
              <div>
                <dt>Roles declarados por el token</dt>
                <dd id="session-roles">{role.value}</dd>
              </div>
              <div>
                <dt>Rol efectivo (precedencia admin &gt; analista &gt; viewer)</dt>
                <dd id="session-effective-role">{role.effective}</dd>
              </div>
            </dl>
            <p id="session-role-note" className="panel-note">
              El rol se lee del claim <code>realm_access.roles</code> del token de acceso, que es la única fuente real: el
              gateway solo publica riesgo, trabajos, prevención y auditoría, así que no existe un endpoint de identidad
              al que preguntar. La página decodifica el payload y <strong>no verifica su firma</strong>; por eso el valor
              es un dato informativo sobre el token y no una autorización. Quien decide es el servidor, que sí verifica
              la firma: concede las lecturas y la marca personal de alerta a <code>viewer</code>,{' '}
              <code>analista</code> y <code>admin</code>; la operación táctica —evaluar, crear y asignar acciones,
              subir evidencia, registrar y adoptar observaciones— a <code>analista</code> y <code>admin</code>; y la
              decisión final sobre la evidencia, la cancelación y la activación de un modelo solo a{' '}
              <code>admin</code>. La precedencia es <code>admin</code> &gt; <code>analista</code> &gt;{' '}
              <code>viewer</code>, decidida por pertenencia y nunca por el orden de la lista.
            </p>
            <h4>Matriz de perfiles y permisos</h4>
            <p id="permissions-matrix-note" className="panel-note">
              Documentación verificada contra las guardas reales del servidor, no contra lo que la interfaz promete. Cada
              fila cita la guarda por <code>ruta#token</code>, la ruta y la cadena de ruta o expresión que la guarda
              contiene, sin número de línea:{' '}
              <code>backend/services/risk/internal/handler/security.go#"viewer"</code> acepta <code>viewer</code>,{' '}
              <code>analista</code> o <code>admin</code>;{' '}
              <code>backend/services/jobs/internal/handler/security.go#holdsTacticalRole</code> acepta{' '}
              <code>analista</code> o <code>admin</code> para disparar trabajo; y{' '}
              <code>backend/services/prevention/internal/handler/security.go#isAnalystOrAdmin</code> separa la
              operación táctica de <code>prevention</code> de la decisión final, que queda en{' '}
              <code>backend/services/prevention/internal/handler/security.go#isAdmin</code>, con{' '}
              <code>backend/services/risk/internal/handler/api.go#Authorize(verifier, mux)</code> y{' '}
              <code>backend/services/jobs/internal/handler/api.go#Authorize(verifier, mux)</code> envolviendo sus
              mux completos. Un token verificado sin ninguno de los tres roles recibe 403; un token que no se puede
              verificar recibe 401.
            </p>
            <TableWrap label="Matriz de perfiles y permisos">
              <table>
                <caption className="sr-only">
                  Matriz documentada de perfiles y permisos, con la guarda real del servidor que la sustenta
                </caption>
                <thead>
                  <tr>
                    <th scope="col">Capacidad</th>
                    <th scope="col">Sin token</th>
                    <th scope="col">viewer</th>
                    <th scope="col">analista</th>
                    <th scope="col">admin</th>
                  </tr>
                </thead>
                <tbody id="permissions-rows">
                  {PERMISSION_MATRIX.map(entry => (
                    // The verified guard travels in a data attribute as well as on
                    // screen: the capability cell carries it for the reader, and
                    // `data-guards` keeps it exactly parseable so the test can
                    // re-read every cited guard from disk instead of trusting a copy.
                    <tr key={entry.capability} data-guards={entry.guards.join(' · ')}>
                      <td>
                        {entry.capability}
                        <br />
                        <code>{entry.guards.length > 0 ? entry.guards.join(' · ') : entry.note}</code>
                      </td>
                      <td>{entry.anonymous ?? ANONYMOUS_UNAUTHORIZED}</td>
                      <td>{entry.viewer}</td>
                      <td>{entry.analista}</td>
                      <td>{entry.admin}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </TableWrap>
            <p id="permissions-unimplemented" className="unimplemented-note">
              No portado a propósito: el mockup retirado permitía <em>elegir</em> un rol en la página. Ese selector no se
              implementa porque la página no puede conceder permisos y un selector sería un límite de autorización falso.
              Tampoco hay selector, conmutador ni preferencia de rol en ninguna parte de esta vista: el rol mostrado es el
              que el token declara y no altera ninguna petición, panel ni decisión.
            </p>
          </section>
        </div>

        <aside className="ops-side">
            {/* Board 17 puts the session facts at the side and the matrix in the
                main column: the matrix is the answer this page exists for, and at a
                340px column its guard citations were unreadable. The panel, its ids
                and its content are unchanged. */}
          <article className="panel auth-panel">
            <div className="panel-heading">
              <div>
                <h3>{signedIn ? 'Tu cuenta' : 'Conectar sesión'}</h3>
              </div>
              <span className="lock-mark" aria-hidden="true">
                ⌑
              </span>
            </div>
            <p className="panel-note">
              {signedIn
                ? 'Tu cuenta vive en Keycloak: ahí cambias tu contraseña, tu nombre o tu correo. FireWatch nunca solicita ni recibe tu contraseña; la API valida los permisos.'
                : 'Inicia sesión en Keycloak. FireWatch nunca solicita ni recibe tu contraseña; la API valida los permisos.'}
            </p>
            {/* F3 — one control, one state. `Shell.tsx` hides the logout control while
                signed out; this one is disabled while a session is established or still
                being established, so an authenticated operator can no longer see an
                enabled "Iniciar sesión" whose only effect would be to restart the OAuth
                flow. With a session it is also hidden: the account link below is the
                only thing this panel can usefully offer an operator who is signed in. */}
            <button
              id="login"
              className="primary-button"
              type="button"
              hidden={signedIn}
              disabled={session.status !== 'signed-out'}
              onClick={() => startLogin()}
            >
              Iniciar sesión con Keycloak
            </button>
            {/* A plain link to the identity provider's own account console. It leaves
                the page on purpose: profile and password changes never pass through
                FireWatch. */}
            <a id="account-console" className="primary-button" href={accountConsoleURL()} hidden={!signedIn}>
              Gestionar mi cuenta en Keycloak
            </a>
            <p className="panel-note">
              El token de acceso permanece solo en memoria mientras esta página está abierta. No se guardan tokens ni se
              envían cookies.
            </p>
            <p id="auth-status" className="auth-status" role="status" aria-live="polite">
              {authStatus}
            </p>
          </article>
        </aside>
      </div>

      {/* Board 17's remaining side content, kept below the layout: how the role
          is verified, and the absences that are deliberate. Both are
          documentation of the shipped behaviour and carry no control. */}
      <div className="ops-duo">
        <OperationsSteps
          id="session-verification"
          titleId="session-verification-title"
          eyebrow="GUARDAS REALES"
          title="Cómo se verifica el rol"
          items={[
            {
              title: 'Keycloak emite el token',
              detail: 'El reino asigna los roles; la página no los elige ni los cambia.',
            },
            {
              title: 'El gateway verifica firma y sujeto',
              detail: 'Un token que no se puede verificar recibe 401 antes de cualquier guarda de rol.',
            },
            {
              title: 'Las guardas del servicio deciden',
              detail:
                'viewer, analista y admin leen; analista y admin operan el flujo táctico; solo admin decide la revisión final, cancela y activa un modelo.',
            },
            {
              title: 'La página solo lee el claim',
              detail: 'No concede ni eleva permisos; el valor es informativo y el servidor sigue siendo la única autoridad.',
            },
          ]}
          note="La página decodifica el payload sin verificar la firma; el servidor, que sí la verifica, es la única autoridad."
        />
        <OperationsStateList
          id="session-limits"
          titleId="session-limits-title"
          eyebrow="LÍMITES"
          title="Qué no hace esta vista"
          items={[
            { label: 'No cambia de usuario', detail: 'La cuenta se administra en Keycloak y la sesión se cierra desde la barra superior.' },
            { label: 'No elige ni eleva un rol', detail: 'Elegir un rol en esta página sería un límite de autorización falso.' },
            { label: 'No edita la matriz de permisos', detail: 'La matriz documenta las guardas reales del servidor, ruta por ruta.' },
            { label: 'No concede permisos', detail: 'El servidor verifica los permisos en cada petición.' },
          ]}
        />
      </div>
    </section>
  );
}
