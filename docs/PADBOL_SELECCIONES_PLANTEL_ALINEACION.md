# Plantel de selecciones y convocación por partido

Modalidad explícita `torneos.modalidad_plantel=selecciones`, únicamente Padbol dobles. El valor predeterminado `dobles` mantiene el registro y resultado actuales de dos jugadores. No se cambia `equipos_usuario`: la competencia utiliza los IDs de `equipos` y `partidos` existentes.

## Ciclo y permisos

Una selección se crea como borrador con su capitán registrado. Capacidad de 4 a 8; puede tener inicialmente un jugador y sólo se confirma para competir con al menos cuatro. La confirmación propia acepta inscripción gratuita conocida, no habilita pagos. El capitán sólo incorpora jugadores que ya solicitaron entrar; el administrador autorizado del torneo puede incorporar UUIDs de perfiles existentes. Nombres y correos provienen del perfil servidor, no del cuerpo enviado por el navegador.

Administración conserva los permisos actuales: SuperAdmin o administrador del club de la sede persistida. No se agrega permiso de administración nacional. La API devuelve `can_edit` y `can_confirm` según estado y autorización. Lecturas de lista requieren sesión; solicitudes de otros jugadores sólo se muestran al capitán/administrador del equipo. La lista y DTOs públicos no exponen correos del plantel.

Una alineación tiene exactamente dos iniciales y dos suplentes, sin duplicados y pertenecientes al plantel confirmado. Guarda revisión CAS (`expected_revision=0` inicialmente). Una revisión antigua responde conflicto, no confirma otro guardado. La alineación se puede modificar mientras torneo/partido estén habilitados y antes de crear un marcador. Los jugadores del plantel ya referenciados por una alineación no se cambian.

El aviso de alternancia dice games impares; no se inventa control de sustituciones ni se considera que un convocado jugó efectivamente cada game.

## Resultado, historial y cierre

El resultado de la modalidad nueva utiliza RPC transaccional: bloquea torneo y partido, conserva las dos alineaciones, valida 2–0/2–1 (o invertido), guarda resultado y participación de cuatro UUIDs por lado juntos. Un intento idéntico es idempotente; resultados distintos, desfinalizar o mover equipos después del registro se rechazan. El marcador conserva sólo los cuatro declarados por lado y bloquea cambios posteriores de su convocatoria.

El historial privado de resultados consulta la participación persistida, identificada como `convocacion_declarada`. No considera automáticamente participantes a los ocho del plantel. El antiguo libro de fechas manuales admite sólo dos por lado y se rechaza para esta modalidad (`manual_date_supported=false`).

El cierre explícito conserva el cálculo interno existente por equipo (BASE_PUNTOS y POSICION_MULT). La RPC de cierre bloquea torneo, partidos y equipos, exige todos los resultados con sus participaciones, guarda puntos y la unión de UUIDs convocados por equipo y cierra en una sola transacción. Repetir exactamente el cierre no cambia fecha ni puntos; un cálculo diferente se rechaza. Rankings y actualización de rangos sólo consideran esa unión, con identidad UUID. No se modifica el ranking oficial FIPA externo. No se agregan fórmulas oficiales, desempates ni formatos de cuadro.

La finalización automática de marcador no cierra esta modalidad: el administrador utiliza Finalizar torneo para conservar el snapshot de puntos y participantes. Cambiar estado mediante el editor general tampoco sustituye ese cierre.

## Orden obligatorio de despliegue

1. Revisar y probar en PostgreSQL aislado el archivo `sql/20261010150000_padbol_national_rosters_lineups.sql` con filas sintéticas. Revisar permisos, arrays, concurrencia, marcador y cierre.
2. Aplicar primero el esquema aditivo al destino aprobado y ejecutar el archivo `.verify.sql`. No publicar código que seleccione columnas nuevas antes de verificarlo: también las lecturas legacy conocen el nuevo valor por defecto.
3. Integrar backend en main limpio, ejecutar suite completa y release:preflight, publicar y comprobar versión/endpoints.
4. Publicar frontend compatible después del backend y ejecutar recorrido visual y ensayo autorizado.

No hay backfill, eliminación ni actualización de filas de negocio en la migración. Las columnas nuevas reciben valores predeterminados legacy. Triggers se limitan a la modalidad seleccionada y bloquean escrituras directas de clientes authenticated incluso con sus permisos RLS administrativos históricos. RPCs de escritura se conceden únicamente a service_role, con autorización HTTP previa. Se mantienen las políticas RLS legacy.

Rollback de esquema sólo se permite mientras no exista ningún torneo, alineación o participación de esta modalidad. Después del uso, preservar el historial y preparar corrección hacia adelante; no borrar registros para forzar rollback.
