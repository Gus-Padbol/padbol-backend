# DG11 — candidato local para revisión independiente

Base: eb9d32ec8c74be0b3e3b0f9ee3694c767deb4571 (main publicado). No activado ni publicado.

Reproducción en la base: el soporte no calificado comercialmente recibe CRM_HANDOFF_NOT_READY; repetir cierre duplica actividades. La evidencia histórica del lifecycle acaba en response_draft_ready, sin cierres.

Corrección acotada, únicamente con supportActivityAtomicEnabled:true inyectado en el servicio: asignación persistida al operador que YA superó las autorizaciones existentes, sin exigir calificación comercial; actividad y estado atómicos con requestId estable ligado a conversación, acción, contenido y estado; reintento recupera la misma actividad. Cierre requiere asignación, outcome registrado y al menos una respuesta confirmada sin respuestas pendientes. No verifica por sí mismo la verdad de la solución. La guarda SQL de respuestas y la del cierre comparten cerrojo de conversación; READ COMMITTED es obligatorio en ese recorrido. No se asigna una identidad técnica nueva ni se amplía visibilidad.

SQL LOCAL PROPUESTO: añade solamente crm_activities.support_command_hash (nullable, conserva históricos), reemplaza la RPC existente preservando ACL e instala trigger de respuestas. No hay GRANT, REVOKE, nuevas cuentas/roles, servicios ni migración remota. La RPC anterior debe existir: no instalar esta propuesta sobre un esquema sin ese prerrequisito/ACL cerrada.

Compatibilidad: opción false por defecto, sin cableado de server.js ni clientes modificado. Las regresiones del circuito actual se conservan. Para activar sería necesario un caller que mantenga requestId ante resultados inciertos y una transición coordinada de la RPC; aplicar SQL aisladamente hace que el caller antiguo de estado de soporte falle por falta de referencia. No es un paquete listo para publicación.

Prueba scripts/dg11SupportHandlers.pg.mjs: usa lector IMAP real, parser MIME real, servicio/repositorio Supabase real con transporte SQL de prueba sobre PostgreSQL17 privado, handlers administrativos montados reales y sender SMTP real con transporte falso. La aplicación Express completa y PostgREST desplegado no se arrancan. La autoridad operator es una fixture inyectada; no acredita un agente autorizado desplegado. No se usa interpretación técnica de Gustavo en la prueba: un driver sintético registra diagnóstico, solución y cierre a través de los handlers. No se presenta ese driver como worker autónomo instalado.

Recuperación probada: misma requestId tras respuesta perdida de commit devuelve registro previo; envío incierto queda pending, no se reenvía ni cierra; fallo del update revierte auditoría. No reconstruir un requestId ante 503. Conservar actividad, hash y comprobantes; no restaurar la RPC anterior para eludir una guarda o reabrir casos. No hay rollback destructivo ni reinicio automático.

Pendientes operativos separados del criterio sintético: conectar al ejecutor/autoridad existente (mini_prepare QA solo prepara, no aprueba/cierra), conservar validación técnica de la evidencia y revisión humana donde corresponda, integrar caller estable, revisar despliegue/SQL y permisos reales por vías autorizadas. QA previamente denegado no se consulta aquí. No se exige inventar un caso comercial real. La revisión independiente decidirá el alcance acreditado; este documento no cambia DG11.
