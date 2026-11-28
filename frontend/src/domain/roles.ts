// The realm-role vocabulary of the ratified access decision (D-C) and the pure
// rules the pages derive from it.
//
// Two facts travel with this module and they are the ones the repository already
// established for roles:
//   1. it reads a claim the page does NOT verify (`realm_access.roles` of the
//      access token), so every answer here is an affordance hint, never an
//      authorization: the server, which does verify the signature, is the only
//      authority and its 401/403 is rendered as the real answer;
//   2. the vocabulary is a SET, never a precedence list read left to right. The
//      demo realm grants its admin account BOTH `viewer` and `admin`, and the
//      order of the claim belongs to the identity provider. This module therefore
//      answers by membership, so a caller keeps the strongest role it holds
//      wherever that role appears in the list.

export type UserRole = 'viewer' | 'analista' | 'admin';

// The closed vocabulary, in ascending privilege order. Anything else a token
// declares is not a role this deployment knows, and a value outside this list is
// never turned into one.
export const USER_ROLES: readonly UserRole[] = ['viewer', 'analista', 'admin'];

// Highest privilege first: the first member a caller holds is its effective role.
export const ROLE_PRECEDENCE: readonly UserRole[] = ['admin', 'analista', 'viewer'];

const ROLE_LABELS: Readonly<Record<UserRole, string>> = {
  viewer: 'Visualizador',
  analista: 'Analista',
  admin: 'Administrador',
};

// `null`, an undefined list and a value outside the vocabulary are all "not a
// declared role": the page never upgrades an unknown string into a permission.
export function isUserRole(value: unknown): value is UserRole {
  return typeof value === 'string' && (USER_ROLES as readonly string[]).includes(value);
}

// The role a page should present for this token: the highest-privilege declared
// role, or `null` when the token declares none of the three. Precedence is
// `admin > analista > viewer`, decided by membership, not by list order.
export function effectiveRole(roles: readonly string[] | null | undefined): UserRole | null {
  if (roles == null) return null;
  for (const role of ROLE_PRECEDENCE) {
    if (roles.includes(role)) return role;
  }
  return null;
}

// The human label of a declared role; an unknown value is never translated.
export function roleLabel(role: string): string {
  return isUserRole(role) ? ROLE_LABELS[role] : role;
}

// The FINAL half of the matrix — approving or rejecting the evidence review and
// cancelling an action — stays administrative. `null`, an empty list and a list
// without `admin` are all "not admin": the page never assumes the permission.
export function declaresAdminRole(roles: readonly string[] | null | undefined): boolean {
  return roles != null && roles.includes('admin');
}

// The TACTICAL half of the matrix — «evalúa y gestiona acciones, sin admin»:
// triggering evaluation and jobs, creating and assigning actions, uploading
// evidence, registering and adopting observations. An admin holds it too.
export function declaresTacticalRole(roles: readonly string[] | null | undefined): boolean {
  return roles != null && (roles.includes('admin') || roles.includes('analista'));
}

// Any of the three declared roles may perform the reads (and the personal alert
// mark); an unknown role may not.
export function declaresAnyDeclaredRole(roles: readonly string[] | null | undefined): boolean {
  return effectiveRole(roles) !== null;
}
