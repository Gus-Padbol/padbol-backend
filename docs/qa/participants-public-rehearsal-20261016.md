# Ensayo público de participantes QA16

Herramienta: `scripts/qa16-participants-published.py`. Ejecutar desde el backend canónico únicamente, tras revisar las migraciones y confirmar la versión pública mediante `--expected-commit`. No publica código ni cambia roles existentes.

La preparación sin `--execute` crea sólo manifiesto y limpieza para revisión. La ejecución confirma el operador QA de sede 8, crea dos cuentas sintéticas mediante Auth Admin API con correo preconfirmado, contraseña aleatoria sólo en memoria y marcadores QA, y registra inmediatamente los UUID devueltos por GoTrue. Prueba el primer JWT antes de crear la segunda cuenta. Los invitados deportivos no obtienen cuentas ni correos.

La semilla SQL requiere que ambas cuentas existan con su marcador exacto; crea únicamente un torneo temporal y perfiles QA. Las consultas CLI usan confirmación no interactiva previamente autorizada y la semilla tiene límites de bloqueo/ejecución. Nunca reutilizar un manifiesto con torneo_id ya asignado sin inspección y limpieza verificadas. Ante un fallo parcial previo a la semilla, conservar el manifiesto y revisar esas cuentas exactas; no crear otras a ciegas.

El ensayo cubre cuatro duplas, capitán con plaza pendiente, duplicados, idempotencia, permisos, completado, vinculación, ausencia de elegibilidad oficial automática, planificación anterior a completar el mínimo e inicio posterior. No acredita torneos oficiales ni modifica resultados. El ensayo completo de selección/marcador/cierre pertenece a las herramientas separadas de selecciones y Nations.

La limpieza verifica nombre, sede, creador y marcadores de las cuentas; rechaza cualquier referencia ajena, resultado o marcador inesperado. Se comparan las filas completas de 39 y 41 antes y después. La corrida pública final del 16/10, release 506bfdd, obtuvo 27 controles PASS en torneo 47; una revisión adicional confirmó 92 conteos residuales en cero, incluidas cuentas, identidades, sesiones, perfiles y roles. El torneo 47 fue eliminado. El primer intento 46 se detuvo por cuentas de prueba creadas directamente en SQL incompatibles con GoTrue; su limpieza también quedó comprobada y se conserva como evidencia de fallo del harness, no como prueba de aplicación.

El entorno humano persistente se prepara por separado, con otro manifiesto y autorización explícita. No debe limpiarse como parte del ensayo temporal.
