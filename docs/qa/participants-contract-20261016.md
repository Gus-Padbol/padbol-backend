# Participant API contract — QA16

Mount `mountTournamentParticipantsRoutes(app,{db:supabaseAdmin,getAuthenticatedUser})` from `routes/tournamentParticipants.js`. All routes authenticate normally; RPC derives stored club scope and locks the tournament. No auth identity is created for a guest. Every new participant has `ranking_oficial_elegible:false`, including after account linking. No historical roster or ranking ledger is rewritten.

`GET /api/torneos/:id/participantes` returns `{ok,torneo_id,sede_id,can_manage,can_register,current_actor:{user_id,nombre},limits:{min_jugadores,max_jugadores},participants:[{id,nombre,tipo_identidad,estado_vinculacion,is_current_actor,ranking_oficial_elegible:false,inscrito,can_claim,can_edit}],teams:[equipo],link_requests:[{id,participante_id,estado,nombre_solicitante}]}`.

`POST /api/torneos/:id/participantes` club-only body `{request_id,nombre,tipo_identidad:'generico'|'plaza_pendiente'}` returns `{ok,torneo_id,status:'created',participante}`.

`POST /api/torneos/:id/inscripciones-participantes` body `{request_id,nombre,incluir_capitan,participantes:[{participante_id}|{tipo_identidad:'generico',nombre}|{tipo_identidad:'plaza_pendiente',nombre:''}]}`. Captain automatically includes their server-resolved identity, even if `incluir_capitan:false` is forged. Administrator defaults to false. Returns `{ok,torneo_id,status:'created',equipo:{id,nombre,inscripcion_estado:'confirmado',jugadores:[...],participants:[...],habilitacion_deportiva:{habilitado,minimos,maximos,jugadores_identificados,faltantes},ranking_oficial_elegible:false}}`.

Capacity: individual1, doubles2, selections4–8. Registration may contain fewer named participants/pending slots; sports readiness remains false until minimum names. A pending slot never counts for play. Enrollment fails once fixture exists; preparing fixture itself does not imply sporting readiness/start.

`POST /api/torneos/:id/participantes/:participanteId/vinculacion` body `{request_id}`. Uses only the authenticated current account, never a user ID supplied by caller. Only a named unlinked guest is claimable; the account needs an identified existing profile. No new age threshold is imposed. Returns `{ok,torneo_id,status:'created',solicitud:{id,participante_id,estado:'pendiente'}}`. Public roster names only are discoverable to logged-in claimants; unsaved private catalog identities stay club/owner-only.

`POST /api/torneos/:id/vinculaciones/:solicitudId/resolver` body `{request_id,decision:'aprobar'|'rechazar'}` is club-only. Returns `{ok,torneo_id,status:'updated',solicitud,participante}`. A conflicting account already attached elsewhere in the event returns409. Linking only connects identity: it does not qualify official ranking or recalculate old points.

All writes require UUID `request_id`: replay same actor/action/payload returns200 `status:'idempotent'`; changed payload/actor conflicts409. New records201, approval200. Errors401/403/404/409/400/503 never become successful receipts.

`assertTournamentTeamsSportReady(db,{torneo,equipos})` from `lib/tournamentParticipantsReadiness.js` is called before start/scoreboard, never before registration or planning. No user UUID is required for a named guest.

`PATCH /api/torneos/:id/participantes/:participanteId` body `{request_id,nombre,tipo_identidad:"generico"}` completes a named guest/placeholder before start, including after planning. Requires `can_edit:true`; server rechecks scope/state/no linked scoreboard. Returns `{ok,torneo_id,status:"updated",participante}`. GET includes all existing legacy teams for administrator, own teams only for players; legacy teams stay readable, not auto-converted.

## Explicit official review (no automatic points)

GET additionally returns `can_accredit` (SUPERADMIN role only), `can_homologate` (SUPERADMIN plus existing official-tier/non-QA DB settings), `homologation_block_reason` (Spanish explanation when not permitted), `homologacion:{estado:'pendiente'|'aprobada',referencia_oficial}`, and scoped `accreditation_requests:[{id,participante_id,estado,nombre_solicitante,referencia_oficial}]`. Each linked own participant can have `can_request_accreditation:true`. Creation/linking alone always leave eligibility false; explicit successful review may make it true.

1. `POST /api/torneos/:id/homologacion`: SUPERADMIN body `{request_id,referencia_oficial,evidencia,confirmar_evento_oficial:true,confirmar_requisitos:true}`. Reference8–1000chars, evidence20–4000chars. Requires actual DB `fipa_registration_enabled:true`, official tier and non-QA event. Snapshots existing `fipa_required_fields` configuration; no invented federation/license or age threshold. Saves an authenticated, audited manual event decision. No flags or real events are populated automatically.
2. `POST /api/torneos/:id/participantes/:participanteId/acreditacion`: linked account itself body `{request_id}`; response `{ok,torneo_id,status:'created',solicitud:{id,participante_id,estado:'pendiente'}}`.
3. `POST /api/torneos/:id/acreditaciones/:acreditacionId/resolver`: SUPERADMIN body `{request_id,decision:'aprobar'|'rechazar',referencia_oficial,evidencia,confirmar_identidad:true,confirmar_requisitos:true}`. Approval requires homologation, linked profile with names and the event's configured fields, non-QA event and actual FIPA registration setting. Receipt `{ok,torneo_id,status:'updated',solicitud,participante}`. New approved eligibility is a prerequisite for official processing, never “points granted”. No historical roster, award, ledger or FIPA CSV is modified.

The guarded `20261016140000_tournament_generic_participants.rollback.sql` rolls back BOTH participant migrations atomically, only when participant, claim, operation, accreditation and homologation data are empty. Never use it to discard live identity/audit records.

GET `homologation_requires_fipa_enablement:true` identifies an official non-QA event whose existing FIPA registration setting is disabled. SUPERADMIN may explicitly submit `habilitar_inscripcion_fipa:true` in the SAME homologation request with reference/evidence and both confirmations. Only that authenticated audited manual action enables the setting; missing confirmation rejects without mutation. Ordinary users/club administrators and QA events cannot enable it.


## Cierre y elegibilidad congelada (migración 1800)

`torneo_participante_ranking_cierres` conserva una fila por torneo/equipo con participantes de registro: `torneo_id`, `equipo_id`, `participantes: [{participante_id,user_id}]`, `closed_at`. La fila se genera dentro de la transacción que cambia el torneo a `finalizado`. Un registro QA o sin aprobación individual/homologación produce una lista vacía. No hay backfill de torneos históricos.

La proyección de ranking debe consultar esta lista congelada; vincular o acreditar una identidad después del cierre nunca modifica la lista. La acreditación manual válida anterior al cierre puede incorporarse; no se inventa un plazo de acreditación anterior al primer partido. El listado deportivo y el resultado histórico conservan sus datos originales.

Servicio tiene lectura; nadie obtiene INSERT/UPDATE mediante REST. El borrado sólo se permite para cabeceras QA con lista vacía, dentro de limpieza administrada de ensayo exacto. Una fila oficial es inmutable. La reversión de las tablas de participantes aborta cuando existen datos de auditoría o funciones de selecciones dependientes: éstas requieren restaurar primero sus versiones anteriores; no existe reversión destructiva automática.
