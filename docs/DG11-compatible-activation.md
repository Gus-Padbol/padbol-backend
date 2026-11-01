# DG11 — transición aditiva y compatible (propuesta local)

Reemplaza la propuesta no compatible dg11_support_activity_atomic.sql, que queda conservada como evidencia anterior y NO debe aplicarse. El archivo nuevo es sql/candidates/dg11_support_activity_compatible.sql. Ninguno fue aplicado a una base real.

## Propiedad por caso, no pausa general

Casos existentes: support_protocol NULL. SQL nuevo + backend anterior o actual con capacidad OFF conserva la RPC legacy, incluyendo actividades sin requestId y notas sin estado. No requiere IDs nuevos, cambia permisos ni adopta históricos. Incluso con capacidad ON, un cliente sin requestId sigue usando el contrato anterior en los casos no adoptados.

El operador YA autorizado elige Tomar caso de soporte desde el caller nuevo. Solo esa asignación, con referencia estable y marcadores construidos por backend, adopta atómicamente el caso al protocolo1; guarda la actividad, su hash, estado y último comando. La pantalla no concede autoridad nueva. Notas/estado posteriores del protocolo1 requieren identidad estable. La sonda sin escrituras de la RPC existente impide que un gate habilitado antes del SQL ejecute accidentalmente el contrato antiguo. Se verifica además identidad/hash del resultado, sin fallback tras incertidumbre.

Un caso adoptado no vuelve silenciosamente al contrato legacy. Las guardas bloquean antiguas pestañas/backends que intentan modificar su estado, insertar una nota sin identidad o reabrirlo; solicitan actualizar/revisar el caso. Las respuestas conservan el claim previo y se serializan con cierre. No se cambian lectura, historial, CRM comercial, recepción o permisos. La guardia de aislamiento READ COMMITTED se limita al protocolo nuevo; el contrato antiguo en casos no adoptados sigue intacto.

## Orden concreto propuesto, aún sin ejecutar

1. Con los permisos ya aprobados para un futuro release, confirmar hashes, esquema/ACL cerrada de la RPC original, origen y estado del destino. No agregar roles ni GRANT/REVOKE; si falta un requisito de permisos, detener y reportar. Conservar respaldo de definición RPC/DDL e inventario agregado de casos; no copiar datos personales.
2. Aplicar SOLO el archivo compatible en su transacción. No migra ni adopta filas históricas. Su fallo revierte columnas/funciones/guardas completo, probado en PostgreSQL privado. Puede aplicarse con backend/caller anterior: la matriz demuestra compatibilidad OFF. No usar la propuesta anterior como una fase intermedia.
3. Publicar backend/caller por el flujo normal con CRM_SUPPORT_PROTOCOL_ENABLED ausente o distinto de true. El cableado del servidor convierte exactamente la cadena true en booleano; no se ha configurado en producción. Pestañas antiguas conservan operaciones en casos no adoptados. Verificar la sonda de protocolo sin escrituras y las versiones antes de habilitar; no crear un caso productivo ficticio.
4. Solo después de revisión y autorización del alcance de activación, habilitar el gate. No se necesita pausa global ni drenar el CRM: la adopción es explícita por caso y comparte bloqueo de fila con los escritores legacy. Una operación anterior termina antes de adoptar o encuentra el caso adoptado y se rechaza sin escritura. El SQL no infiere permiso de agente técnico; esa autoridad y la evidencia de solución siguen pendientes por separado.

## Recuperación

Apagar CRM_SUPPORT_PROTOCOL_ENABLED no cambia permisos ni revierte el SQL. Pausa solo las nuevas mutaciones de casos ya adoptados; los no adoptados continúan legacy. Una orden pendiente conserva requestId y contenido/huella. Al reactivar versión compatible se recupera la misma orden, sin duplicar auditoría. Mantener lectura e historial; no borrar hash, último comando, propiedad del protocolo ni filas para destrabar un caso.

No restaurar la RPC antigua ni quitar guardas con casos adoptados. Un rollback de aplicación anterior conserva los casos antiguos y las guardas de los adoptados; estos últimos quedan protegidos hasta volver a código compatible, no silenciosamente reenviados. No crear reintentos automáticos ni otro receptor.

## Evidencia local

scripts/dg11SupportCompatibility.pg.mjs usa handlers y repositorio del backend eb9d32ec importados solo como fixtures de referencia, payload legacy real sin requestId y SQL nuevo; también ON temprano sin esquema, OFF actual, pestaña vieja con ON, adopción, pérdida/recuperación por gate, nota directa, handoff legacy, aislamiento y rollback DDL. scripts/dg11SupportHandlers.pg.mjs y dg11SupportCallerDelta.pg.mjs usan la propuesta compatible. Prueba React adicional comprueba nueva UI + capacidad ausente del backend anterior sin requestId. Proveedores/autoridad/diagnóstico falsos, PostgreSQL efímero y red externa bloqueada; no acreditan operación autónoma desplegada. Revisión independiente requerida; DG11 no cerrado por este documento.
