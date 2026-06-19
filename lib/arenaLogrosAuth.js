/**
 * Resuelve el user_id efectivo para POST /api/arena/logros.
 * body.user_id se ignora siempre (prevención IDOR).
 */
export function resolveArenaLogrosTargetUserId(authenticatedUser, _body = {}) {
  const id = authenticatedUser?.id;
  return id ? String(id) : null;
}
