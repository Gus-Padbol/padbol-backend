# Next Generation admin — preparación QA

Esta rama incorpora al backend oficial las rutas administrativas operativas de
Next Generation y la migración `20261005170000_next_generation_operations.sql`.

## Entorno identificado

- Supabase QA: `padbol-match-qa` (`vxikhdulhuvghfqeutnp`).
- Backend QA actual: `https://padbol-backend-qa.onrender.com`.

La CLI reconoce el proyecto QA, pero este repositorio no está enlazado y no hay
una credencial inequívoca para ejecutar la migración. Por seguridad, la
migración no se aplicó desde esta rama.

## Orden pendiente

1. Enlazar temporalmente este repositorio al proyecto QA con una credencial de
   base de datos QA, nunca de producción.
2. Revisar y aplicar `supabase/migrations/20261005170000_next_generation_operations.sql`.
3. Confirmar tablas y funciones RPC en QA.
4. Habilitar una rama QA autorizada por el preflight o fusionar mediante Pull
   Request siguiendo la política del repositorio.
5. Confirmar que Render QA despliega desde `Gus-Padbol/padbol-backend`. En este
   momento la evidencia disponible apunta a una rama histórica del monorepo.
6. Desplegar y comprobar, sin sesión, que
   `GET /api/admin/next-generation/overview` responde 401 y no 404.
7. Repetir con cuentas reales de superadmin y admin de sede.

## Verificación local

- Suite completa: 1492 pruebas aprobadas.
- `release:preflight`: bloquea correctamente esta rama porque sólo autoriza
  `main`; por ese motivo no se desplegó.
