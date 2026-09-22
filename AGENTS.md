# Padbol Match Backend — reglas permanentes

Este es el único repositorio autorizado para modificar y desplegar el backend:

`/Users/padbol2022/PADBOL-LAB-DEEPSEEK/padbol-backend-canonical`

No implementar ni desplegar desde copias de Escritorio, `/Users/Padbol-Match-Desarrollo`, `TEST-DEEPSEEK` o `/private/tmp`. Esas copias son sólo referencia.

Antes de modificar o desplegar, comprobar raíz Git, rama, HEAD, remote, árbol y entorno destino. QA y producción son destinos distintos. Un cambio probado sólo en QA no se considera presente en TestFlight.

Antes de un despliegue ejecutar `npm run release:preflight` y `npm test`. No desplegar un árbol sucio. Verificar públicamente los endpoints afectados después del despliegue antes de pedir una prueba en el teléfono.
