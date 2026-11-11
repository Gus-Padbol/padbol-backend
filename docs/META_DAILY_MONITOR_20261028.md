# Lectura diaria de Meta y avisos internos

Implementación preparada, desactivada por defecto. No configura accesos, no crea tokens, no modifica campañas, presupuestos o públicos y no envía correo ni WhatsApp.

## Integración de arranque

Después de crear el pool PostgreSQL en el servidor:

```js
import {createMetaDailyMonitor} from './lib/contentMetaMonitor.js';
const metaDailyMonitor = createMetaDailyMonitor({pool: pgPool});
metaDailyMonitor.start();
// En el cierre ordenado del servidor: metaDailyMonitor.stop();
```

El proceso revisa una vez por hora y ejecuta una sola sincronización diaria a partir de las 06:00 de `America/Los_Angeles`. Solo utiliza días completos: refresca los últimos 14 días en campaña, conjunto y anuncio por separado, conservando originales y auditoría del lector existente. Revalida en la base que la cuenta configurada siga siendo dueño o coordinador antes de llamar a Meta, y el lector también valida ese permiso en cada operación.

Un bloqueo PostgreSQL de sesión evita trabajos simultáneos entre instancias. El estado diario evita repetir un trabajo finalizado. Los fallos quedan registrados con códigos controlados, se pueden reintentar en la siguiente revisión y no se presentan como una conexión correcta. Eventos de intento y avisos quedan conservados en tablas privadas con historial inmutable.

## Autorización pendiente antes de activar

La cuenta autorizada es `1354015098808083`, moneda USD, zona `America/Los_Angeles`. La credencial actual de WhatsApp no cuenta con `ads_read` y no debe reutilizarse.

Configurar mediante el almacenamiento protegido del servidor, nunca por correo, chat, código o navegador público:

- `META_ADS_READ_ACCESS_TOKEN`: credencial dedicada con permiso de lectura de estadísticas de la cuenta autorizada.
- `META_ADS_READ_ACCOUNT_ID=1354015098808083`
- `META_ADS_READ_GRAPH_VERSION`: versión Graph autorizada y probada, con formato `vNN.N`.
- `META_ADS_AUTO_SYNC_ACTOR_ID`: UUID de una cuenta existente de dueño/coordinador cuyo permiso persistido ya esté vigente. No concede permisos.
- `META_ADS_AUTO_SYNC_ENABLED=true`: activar solo después de aplicar la migración y comprobar una lectura manual. Sin esta opción no hay ejecución ni conexión automática.

Aplicar `sql/migrations/20261028150000_content_meta_monitor.sql` después de la migración de resultados Meta del 26/10. Reiniciar con variables protegidas. Ejecutar `runOnce()` desde el módulo de arranque en un contexto administrativo autorizado o esperar la revisión horaria. No conectar una credencial más amplia de la necesaria. No almacenar estos valores en el frontend.

## Qué se muestra

`GET /api/admin/content/workspace/meta/monitor` utiliza la autenticación y el permiso de coordinación de Contenido y campañas, y vuelve a comprobar `content_meta_access` en PostgreSQL. Un diseñador no puede leerlo. Devuelve estado, cobertura, última ejecución y hasta cien avisos recientes, sin credenciales ni UUID de la identidad de ejecución.

Comparación: últimos siete días completos contra los siete anteriores, únicamente a nivel campaña, con fuentes completas API de los 14 días. Se requiere cobertura de los 14 días; si falta, se muestra un aviso de cobertura en lugar de deducir ceros.

Umbrales iniciales visibles en `policy`:

- Impresiones: descenso de al menos 40%, con 1.000 impresiones mínimas en el período anterior.
- Clics de enlace: descenso de al menos 40%, con 20 clics de enlace mínimos en el período anterior y sin valores faltantes.
- Costo por clic de enlace: aumento de al menos 50%, con al menos USD 20 y 20 clics de enlace en ambos períodos.
- Una campaña con gasto anterior relevante que deja de devolver filas produce un aviso de falta de entrega/cobertura, sin inventar valores de rendimiento.

Son umbrales operativos iniciales y anomalías para revisión humana, no un diagnóstico comercial. Los resultados atribuidos por Meta no son ventas, reservas o consultas verificadas del CRM. No se suman niveles ni alcance diario. Estos avisos son diarios; no se afirma detección inmediata ni en tiempo real.

## Verificación

1. Confirmar que apagado o sin credencial no llama a Meta ni escribe ejecuciones.
2. Con lectura legítima, validar cuenta, moneda y zona; ejecutar sincronización y revisar `latest.status=succeeded`.
3. Confirmar campaña/conjunto/anuncio conservados por separado, fuentes originales y fechas completas.
4. Probar dos instancias: una obtiene el bloqueo y la otra devuelve `busy`.
5. Un segundo intento del mismo día finalizado devuelve `already_completed`.
6. Revocar el permiso persistido de una cuenta de ensayo autorizada: el trabajo debe rechazar antes de leer Meta. No alterar cuentas reales para esta prueba.
7. Un error de acceso debe verse como fallo, sin exponer secretos y sin sustituir datos históricos por cero.
8. Comparar los avisos con Ads Manager. La evaluación y cualquier cambio de campaña corresponden a Juanpi y dirección.
