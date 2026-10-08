# Integración revisada de cierre e informe mensual

10Sep2026. Base QA1aecc32 más tarifa0%de producción9087fa8. Cierre automático, lectura de campeón y evaluador integrados en copia aislada. 308 pruebas locales únicas aprobadas, incluido el circuito motor→sync→cierre→informe. No desplegado. La regla vigente exige final digital con campeón, otros resultados manuales válidos,12reservas y10personas; todas las metas conjuntas. Esta nota sustituye la versión anterior del50%general de marcador.

Preflight QA real sólo lectura confirmó84/85columnas: falta origen_creacion. No se aplicó SQL. Roles efectivos de backend, operación QA autenticada, políticas de escritura directa y diferencias comerciales de asistencia/origen/actividad siguen pendientes antes de habilitar beneficios. Cobros/créditos/descuentos persistidos continúan OFF.

## Entrega del evaluador de referencia

# Candidato mensual actualizado — 10 septiembre 2026

**Estado: implementación aislada, sin publicación ni aplicación de SQL remoto.** La definición vigente sustituye el 50% general de marcador por cierre de la final mediante marcador y campeón. Los demás partidos pueden registrar sus resultados manualmente. Este paquete no activa descuentos ni cobros.

Fuente del candidato anterior: `/private/tmp/padbol-incentives-v4-qa-integration-20260910`, backend basado en QA `1aecc325c1d901294aa6f5a5dc8e618b2a388e02`. Nueva copia de trabajo: `/private/tmp/padbol-incentives-v4-twelve-reservations-20260910`. Panel de trabajo: `panel-contract/src/components/AdminIncentivosSection.jsx`.

## Regla implementada

Versión explícita **`activity-v4-final-scoreboard-results-reservations12`**. El cambio de versión evita interpretar como aprobados los programas anteriores de diez reservas o del 50% general de marcador.

1. Organizar y finalizar al menos un torneo Padbol del mes con ocho parejas distintas, inscritas como confirmadas y formadas por dieciséis cuentas reales. El cuadro debe estar completo, con avances coherentes, final y campeón. La final requiere evidencia del marcador. No alcanza con imponer `estado='finalizado'` ni con registrar cuatro partidos entre ocho parejas.
2. Registrar todos los resultados del torneo. Los partidos anteriores a la final pueden cargarse manualmente, con sus sets y ganador coherentes. No hay mínimo porcentual de uso general del marcador. Una final registrada sólo manualmente permite acreditar el registro de resultados, pero no la meta de cierre según la última aclaración.
3. Completar **doce reservas** del mes desde el autoservicio del jugador, con asistencia registrada y cuenta con email o teléfono confirmado. Pendientes, canceladas, sin asistencia, de otra sede/deporte, usuarios no comprobados y registros sin procedencia acreditada quedan fuera.
4. Contar **diez jugadores distintos con actividad real**. Se unen los participantes efectivos de partidos con resultado válido y los titulares de reservas acreditadas de esa sede; se deduplican por usuario. No tienen que ser nuevos, ni realizar un alta de vínculo adicional. Estar inscrito o vinculado sin actividad no suma. Doce reservas del mismo usuario representan doce reservas y una persona.

Las cuatro metas continúan siendo conjuntas; superar una no compensa otra ni aumenta el descuento. Se conservan 68/34/17 como proyección comercial para sede exclusivamente Padbol; el club mixto sigue con cotización pendiente. `billing_enabled`, crédito otorgado y persistencia de progreso siguen desactivados.

El dashboard separa los recuentos de actividad de la condición del beneficio: puede mostrar más torneos, más reservas o un porcentaje de uso del marcador sin otorgar más descuento. Muestra las cuatro metas y su cumplimiento conjunto; cerrar la final acredita la meta de torneo, no las otras tres. El 50% adicional sigue requiriendo todas, sin puntos por meta ni descuentos parciales. Los estados de evidencia ausente/no comprobada no se muestran como cumplimiento.

## Evidencia y límites de inscripción/cierre

Las parejas usan UUID de usuario, perfil existente y cuenta real no anónima/no eliminada comprobada por Auth del servidor. No se exige pago de inscripción: un torneo gratuito puede cumplir. Esto prueba cuentas registradas y su participación, **no que cada jugador haya hecho personalmente el clic de inscripción**. El esquema/equipos actual no acredita ese origen individual; no se inventó una etiqueta ni se rellenó historia para afirmarlo.

La estructura admitida es la de los generadores existentes `knockout` y `grupos_knockout`: rondas/posiciones, enlaces y slots al siguiente partido, ganadores que realmente avanzan y final. Para grupos se revisa el calendario completo de emparejamientos registrado. Otros formatos o cuadros históricos sin esa estructura quedan con cierre no acreditado; no se certifica su reglamento ni se les inventa un mínimo comercial de partidos.

El escritor de cierre automático, su fecha idempotente y la protección de `PUT /api/torneos/:id` se preparan en el lote separado `/private/tmp/padbol-tournament-final-closure-20260910`, a cargo de `incentive_rule_audit`. **Este evaluador depende de integrar ese lote**: por sí solo no realiza la transición de estado del torneo ni impide que un backend anterior acepte una etiqueta manual de finalizado. El contrato compartido conserva `torneos.fecha_fin` como mes UTC de cierre y exige `synced_to_torneo_at` del mismo mes. Su reintento no debe desplazar la fecha.

Ya está incorporado, byte a byte, su helper `lib/torneos/terminalScoreboardPoint.js`, SHA-256 `1fd57b756d48527908260702f9898a2461a3a844c4f4892ce7e59971309d5fc8`. Reconstruye el estado previo y aplica el punto con la lógica real del marcador: sólo acredita la final si ese punto termina el encuentro y coincide con sets/historial finales. Un punto cualquiera, un snapshot incompleto o una final manual no alcanzan. El resto de la evidencia mantiene autoría de partido/sede/torneo, mes, sincronización y campeón coherentes. Los campos previos del punto ya existen en el esquema de referencia y están incluidos en el preflight pendiente.

No existen snapshots mensuales inmutables. Los resultados, cuentas y registros consultados pueden cambiar; el informe se recalcula. Este candidato no constituye una liquidación definitiva.

## Procedencia de reservas: solución compatible y protegida

El esquema anterior no distingue de forma fiable reserva manual de administrador y reserva propia del jugador. El administrador usa también `POST /api/reservas`; su rol no demuestra que esté creando una reserva manual. Por eso no se clasifica por rol ni por un campo enviado por el cliente.

La migración aditiva `backend/sql/20260910220000_reservas_origen_creacion.sql` crea `reservas.origen_creacion`, nullable para preservar registros y clientes anteriores. Nuevas reservas se sellan exclusivamente desde:

- `routes/reservaPendienteMp.js`: `checkout_jugador_v1` al insertar una reserva nueva desde checkout autenticado, con propietario del contexto servidor. Pagar/reutilizar una reserva anterior no la reclasifica. Importes, cotización y proveedores permanecen iguales.
- `routes/partidos.js`: `encuentro_jugador_v1` al crear una prereserva desde el flujo autenticado del capitán. El valor no proviene del body.

La protección SQL rechaza sellos aportados mediante escritura directa de roles `authenticated`/`anon`, impide cambiar o añadir origen posteriormente y lo invalida si se reasigna propietario o sede. Conserva las actualizaciones ordinarias de estado. Sólo los roles servidores comprobados pueden insertarlo (`service_role`, `postgres`, `supabase_admin`). **Debe comprobarse el rol real de los dos clientes backend de QA antes de aplicar**, sin deducirlo del rol de la CLI administrativa. Si usa otro rol, revisar ese contrato; no ampliar permisos por suposición.

No se rellena ningún histórico. El panel informa cuántas reservas reales con asistencia no tienen procedencia acreditada. La ruta compartida manual/histórica queda sin sello, también si la utiliza un administrador para sí mismo: no se afirma un origen que no se puede distinguir.

El flujo principal Android está cubierto: `ConfirmacionScreen.js` llama a checkout autenticado, y el encuentro llama a `crear-con-prereserva`. No hace falta cambiar ese caller. El fallback antiguo de `PagoExitosoScreen.js`, que usa `POST /api/reservas` cuando falta una reserva, permanece sin origen acreditado; no se convierte automáticamente en beneficio. El sello distingue autoservicio de carga manual, no certifica que el dispositivo físico sea Android frente a una app web.

## Pruebas y privacidad

La evidencia de pruebas y hashes finales se conserva en `verification.json`, `backend-tests.log`, `panel-tests.log` y `origin-migration-local-results.json`. Las pruebas backend ejercitan contratos reales con límites DB/Auth sintéticos; el panel recibe respuestas generadas por el evaluador y las rutas reales. Ninguna prueba produjo pagos, correos, usuarios o reservas remotos.

Resultado final: **86/86 pruebas backend**, **21/21 pruebas del panel**, **15/15 escenarios PostgreSQL local con 9 aserciones SQL**. Incluye final con único punto digital acreditado y los otros catorce resultados manuales, resultados faltantes, punto que no termina el partido, cuadro sin final, cuenta huérfana, reservas 10/11/12, duplicados, origen falso, permisos de sede y conservación del motor anterior. La validación de último punto reutiliza la lógica existente y no implica que se hayan reconstruido todos los puntos del partido.

Parches finales, verificados con `git apply --check --whitespace=error` y aplicación en copias de las bases exactas, con hashes de resultado coincidentes:

- `delivery/backend.delta.patch`: 12 archivos. SHA-256 `c3cb9d9dad933b8e60dc289b9a356d4fc7e6f7ce4e61c04b5869de797949969e`.
- `delivery/panel-contract.delta.patch`: 4 archivos. SHA-256 `3a528223887ad4f01d94cfab9251c63e6cc86ea0eae2c3365a361dfb572a42d5`.
- SQL de origen: SHA-256 `62a84b7f64ba12bcefdf39dc0f2a731450c4a4131d18a7619648154bef559dc7`.

El parche de panel usa rutas `src/components/...` para el frontend y contiene dos tests y las respuestas sintéticas generadas. Las fuentes anteriores/posteriores están en `delivery/before` y `delivery/after`. `server.js`, pricing, resolución de roles y motor anterior de incentivos conservan exactamente los hashes del baseline; están registrados en `verification.json`.

Para repetir las pruebas sin actividad remota, desde `backend`:

```sh
/Users/padbol2022/.nvm/versions/node/v22.23.1/bin/node --test lib/sedeIncentivesV4.test.js lib/sedeIncentivesV4.routes.test.js lib/sedeIncentivesTwelveReservations.test.js lib/reservaPendienteMp.test.js lib/postReservas.test.js lib/sedeIncentives.test.js
```

Desde la raíz de este candidato, generar las respuestas sintéticas del panel:

```sh
/Users/padbol2022/.nvm/versions/node/v22.23.1/bin/node export-panel-fixtures.mjs
```

Desde `panel-contract`:

```sh
CI=true /Users/padbol2022/.nvm/versions/node/v22.23.1/bin/node node_modules/react-scripts/bin/react-scripts.js test --watchAll=false --runInBand --runTestsByPath src/components/AdminIncentivosSection.test.jsx src/components/AdminIncentivosBackendContract.test.jsx
```

La prueba SQL local se repite desde la raíz con `python3 test-origin-migration-local.py`; crea una base nueva en el contenedor local de pruebas. `python3 package-delta.py` regenera los parches y verifica aplicación/bytes contra la base declarada. Antes de integrar en otra rama, ejecutar `git apply --check` de cada parche en su checkout destino y revisar cualquier conflicto con los lotes de cuatro deportes y cierre de final.

SQL ejecutado únicamente en PostgreSQL local 17.6, base desechable: primera aplicación, idempotencia, clientes anteriores, rechazo de escritura directa/retroactiva, preservación de registros e historial y reasignación. Se conserva el runner `test-origin-migration-local.py`.

Revisión de privacidad: se añade una procedencia operativa de dos valores, sin contactos ni identificadores nuevos. Se comprueba en servidor la existencia de las cuentas ya participantes; no se modifican Auth, sesión, Storage ni permisos del usuario. El informe sólo presenta recuentos y referencias de torneo; no devuelve datos de las cuentas consultadas. No se agregan proveedores ni comunicaciones. La nueva columna y su protección quedan pendientes de aplicar, y su uso debe incorporarse al inventario técnico de publicación.

## Integración pendiente

1. Aplicar **sólo los deltas** revisados sobre la rama de integración actual. No publicar esta copia completa: su baseline QA conserva código histórico del 3% en archivos de pricing que este paquete no modifica. El 0% al jugador ya publicado y el contrato separado del servicio a cancha Padbol deben conservarse. La regla de cobro a sede no se deduce de estas metas.
2. Revisar los cruces de `routes/partidos.js` con el lote de cuatro deportes y los archivos compartidos con el cierre autoritativo. Integrar hunks; no sobrescribir archivos completos de otros agentes.
3. Ejecutar el preflight de QA y comprobar tabla, columnas, trigger, roles reales y el mecanismo de registro de la nueva migración. Aplicar únicamente la migración aprobada de procedencia, conservando el historial previo; este SQL no registra su propia versión. No hacer un push indiscriminado de migraciones.
4. Integrar el cierre autoritativo de final y comprobar un torneo sintético completo: otros resultados manuales, último punto de la final, campeón y fecha estables al reintentar. Falta la operación autenticada real en QA; las fixtures locales no la sustituyen.
5. Crear un programa QA explícito con la nueva versión, sin convertir programas reales anteriores ni activar cobros. Verificar doce reservas acreditadas, diez usuarios distintos, rechazos por cruce de sede y el panel con ese backend QA.
6. Sólo después de la revisión integral del coordinador corresponde promover versiones y actualizar clientes. No se cambió ningún entorno, repositorio activo, publicación ni compilación Android en esta tarea.
