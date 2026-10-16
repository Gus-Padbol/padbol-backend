# Participantes deportivos en nuevas Nations Cup

La migración1700 habilita únicamente referencias persistidas en `torneo_participantes`, vinculadas al torneo y sede exactos. No actualiza eventos, equipos ni usuarios existentes. Los planteles históricos con UUID de cuenta mantienen su ruta anterior. Una selección puede registrar hasta8 plazas; necesita4 integrantes identificados para iniciar y declarar2iniciales+2suplentes por partido. El marcador conserva sólo esos4 y el acta conserva sus referencias deportivas. Las cuentas no se inventan.

La identidad de ranking se deriva del registro protegido y la acreditación manual explícita, nunca de un UUID libre en JSON. Un invitado sin cuenta/acreditación no se transforma en jugador oficial al cerrar. El recibo HTTP de cierre acepta cuentas vinculadas verificadas sin reescribir el plantel histórico. La proyección de lectores de ranking se revisa por separado.

## Verificación local

PostgreSQL16: base propia `nations_registry_qa16`, clon de `planning_full_qa16` sin datos de ensayo persistidos. Bootstrap previo: `sql/tests/20261016_selection_integrated_bootstrap.sql`, DDL nacional original `sql/20261010150000_padbol_national_rosters_lineups.sql`, migraciones1000/1030/1400/1600. Añadir `sql/tests/20261016_nations_registry_bootstrap.sql`, DDL completo Nations `sql/20261011150000_nations_cup_event_plan.sql`, tercerpuesto `sql/20261013120000_nations_third_place.sql`,1700. No es una copia íntegra del esquema de producción.

`sql/tests/20261016_nations_registry_assertions.sql` ejecuta una transacción conROLLBACK:15selecciones×8invitados; configuración privada; aprobación;3zonas×5;30partidos de grupo;8eliminatorios incluido tercerpuesto;38alineaciones por lado, marcadores vinculados, resultados y evidencias; cierre atómico;300puntos por equipo de prueba;0cuentas creadas/identidades oficiales; eventos anteriores idénticos. Repetir con `SET padbol.test_partial_roster='1'` para4nombres+4plazas pendientes.

Límite explícito: el ensayo SQL aplica la actualización de casilla ganadora que normalmente efectúa el servicio JavaScript; no demuestra ejecución HTTP del avance. La suite de servicios JavaScript cubre ese contrato por separado. La clasificación/rangos finales del ensayo SQL son datos preparados para probar la transacción, no una validación independiente de los criterios deportivos. El ensayo público completo debe comprobar el servicio real y su resultado antes de declarar publicación verificada.

45pruebas JavaScript dirigidas PASS: lineup, recibo de cierre vinculado acreditado/noacreditado, permisos de capitán, ruta Nations coninvitados, sorteo mínimo4 y servicios de marcador. No se ejecutó publicación ni escritura en39/41 por este agente.

## Sincronización final de marcador (1900)

La revisión detectó un fallo adicional: cargar un resultado manual terminaba el partido y avanzaba la llave, pero dejaba su marcador abierto.1900 proyecta ese resultado autorizado al marcador ya vinculado, dentro de la transacción. No crea marcadores ni games ni historial de puntos. Copia sets y games reales sólo si constan; si no hay detalle conserva NULL. Repetir el mismo resultado no vuelve a escribir el marcador.

Reproducción local independiente desde el canónico: `PYTHONDONTWRITEBYTECODE=1 python3 scripts/verify-nations-registry-local.py --database nombre_nuevo`. Crea exclusivamente una base local nueva, deja0filas de participantes/marcadores/partidos/snapshots luego deROLLBACK y rechaza nombres existentes. Ensayo38repetido con1900, marcadores terminales/sincronizados, PASS. Los scripts publicados `scripts/qa16-selection-planning-published.py` y `scripts/qa16-nations-guests-published.py` están preparados con manifiesto y limpieza exacta; requieren revisión del coordinador y hash publicado explícito para ejecutar.
