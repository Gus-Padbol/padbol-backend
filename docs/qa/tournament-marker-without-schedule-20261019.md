# Torneos: marcador sin programación previa — 19/10/2026

Observación nueva del correo 1a154ee98c4ae0ec. Ambos circuitos, habitual y Nations, permiten elegir cancha y abrir marcador sin fecha/hora ni duración. Se precargan participantes desde el cruce existente. La programación sigue siendo opcional. Abrir el control no inicia el reloj: el operador pulsa **Iniciar partido** cuando empieza realmente; ni retrasos ni el horario estimado lo arrancan.

## Cambios y controles

- GET operación conserva comprobación de torneo iniciado e integrantes listos; POST marcador exige la sesión autorizada, la misma sede y una cancha habilitada del deporte correcto.
- RPC `preparar_marcador_torneo_ahora` asigna cancha sin inventar fecha ni duración; no escribe programación ni resultados. Bloquea la cancha durante comprobaciones y respeta reservas/clases/programaciones ajenas activas ahora.
- Trigger en scoreboard serializa inserción/asignación de pantalla y evita dos marcadores activos de la misma cancha o de equipos compartidos. Los finalizados liberan la cancha. Se preservan los marcadores manuales de cancha de texto libre y los controles activos históricos: se valida una nueva asignación o reactivación, no cada uso del control. Los nuevos marcadores manuales de cancha oficial sí respetan ocupación. Regresiones SQL específicas PASS. El marcador vinculado conserva la sincronización y progresión de resultados existentes.
- La migración no actualiza filas existentes; rollback elimina únicamente función/trigger. No se alteraron torneos 39, 41, 48 ni datos remotos.

## Evidencia local

Backend 2298 pruebas PASS; frontend 196 suites / 1484 pruebas PASS y build PASS antes de agregar dos controles Nations adicionales. SQL probado en PostgreSQL WASM aislado (PGlite): permisos, cancha ajena, ausencia de programación y autoinicio, reserva activa, pantalla ocupada, segundo insert rechazado, liberación al terminar y rollback conservando partidos. Assertions reutilizables: `sql/tests/20261019_marker_without_schedule_assertions.sql`, con bootstrap 20261016_tournament_planning_bootstrap + migraciones. Harness local /tmp/qa19-pg.mjs.

`release:preflight` requiere rama main y falla únicamente en esa condición al trabajar en la rama derivada. Debe repetirse tras integrar. No se publicaron cambios. Requiere revisión independiente, aplicación de migración coordinada antes del backend, comprobación visual desktop/móvil y recorrido integrado en QA con un torneo nuevo antes de declarar disponible en línea.

La comprobación de dos inserciones secuenciales contra el trigger no constituye una simulación de dos transacciones concurrentes reales; esa prueba adicional debe hacerse en PostgreSQL con dos sesiones si se necesita afirmar concurrencia verificada.

## Contraste con guardas reales de producción

La revisión independiente detectó que `proteger_marcador_nations` seguía exigiendo una fila de programación, aunque el endpoint ya no la pedía. La migración reemplaza esa guarda: valida torneo, partido, sede y cancha oficial asignada, sin exigir horario/duración. Un marcador futuro pendiente sin cancha puede existir sin apropiarse de una pantalla; al elegir cancha se vincula el mismo marcador. La guarda de selecciones permanece intacta y sigue congelando exactamente cuatro convocados de los ocho integrantes.

Se incorporó como fixture la definición exacta de las tres funciones de producción relacionadas (sin datos ni credenciales) en `sql/tests/20261019_scoreboard_production_guard_baseline.sql`. El harness carga baseline/trigger antes de aplicar la migración; `20261019_nations_marker_without_schedule_assertions.sql` comprueba Nación sin programación, convocados, marcador futuro, asignación, inicio explícito/cierre, ocupación liberada y rechazos de sede/deporte/cancha inactiva. Rollback restaura la función Nations exacta y `pg_get_functiondef` coincide con el baseline. Todos PASS en PostgreSQL aislado.
