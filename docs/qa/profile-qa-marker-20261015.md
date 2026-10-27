# QD10: perfiles sintéticos y métricas

La migración es aditiva y no marca ningún perfil. Aplicarla antes del backend que selecciona `es_prueba`; si falta la columna, el endpoint falla explícitamente, no devuelve un conteo inventado.

El operador debe revisar UUID y `auth.users.raw_app_meta_data` (nunca `raw_user_meta_data`). Son pruebas válidas las claves de servidor `qa_test: true` y un `qa_fixture` no vacío, o el manifiesto exacto aprobado del fixture. Un nombre, correo, dominio o rol no demuestra que una persona sea ficticia.

Para la clasificación, preparar una lista exacta de UUID y evidencia del fixture. Dentro de una transacción: comprobar que todos los UUID existen en auth y jugadores_perfil, verificar la evidencia guardada, bloquear esas filas, actualizar únicamente esos UUID a es_prueba=true y confirmar que el número actualizado coincide con el manifiesto. Registrar los UUID y conteos anteriores/posteriores sin exportar credenciales ni metadatos ajenos. Ante cualquier diferencia, ROLLBACK. No ejecutar un UPDATE global por patrón de nombre o correo. No clasificar todos los usuarios de una sede por pertenecer a ella.

Tras el marcado: verificar que las métricas excluyen exactamente el manifiesto y que los perfiles reales conservan su conteo. Los jugadores QA siguen disponibles en los flujos privados de prueba, sin modificar reservas, equipos, puntos, permisos ni datos del torneo39.

El trigger SECURITY INVOKER valida el rol PostgreSQL efectivo: authenticated/anon no pueden insertar true ni cambiar la marca. Las escrituras normales con false quedan permitidas por las políticas existentes. Verificar en una transacción revertida los roles efectivos authenticated, anon y service_role antes de publicar. Estas verificaciones SQL no se realizaron en producción en esta rama.
