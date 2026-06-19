/** Public review row — no user_id or reserva_id. */
export function mapResenaPublicRow(mapped) {
  if (!mapped) return null;
  return {
    id: mapped.id,
    sede_id: mapped.sede_id,
    puntuacion: mapped.puntuacion,
    comentario: mapped.comentario,
    created_at: mapped.created_at,
    respuesta_admin: mapped.respuesta_admin,
    respuesta_at: mapped.respuesta_at,
    display_name: mapped.display_name,
    foto_url: mapped.foto_url,
  };
}
