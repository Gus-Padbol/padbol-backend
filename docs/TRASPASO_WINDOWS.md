# Continuidad del backend desde Windows

La guía integral está en `Gus-Padbol/padbol-match`, archivo `docs/TRASPASO_JUAN_PABLO_WINDOWS.md`, rama `handoff/juan-pablo-2026-10-06`.

Este es el backend oficial. No desplegar desde copias de `TEST`, ZIP, Escritorio o repositorios antiguos.

## Inicio rápido

```powershell
git clone https://github.com/Gus-Padbol/padbol-backend.git
Set-Location .\padbol-backend
git switch handoff/juan-pablo-2026-10-06
Copy-Item .env.example .env
npm ci
npm test
npm run dev
```

La suite aprobada al entregar tiene 1.482 pruebas. El control `npm run release:preflight` solo aprueba `main` y el remoto oficial; ese bloqueo no se debe quitar.

Los scripts `qa-align-privacy-registry-20260925.sql` y `qa-restore-privacy-registry-20260925.sql` son exclusivamente para el proyecto QA identificado dentro del propio script. No ejecutarlos en producción.
