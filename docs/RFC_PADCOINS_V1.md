# RFC PadCoins V1 - Padbol Match

## Objetivo

Definir el modelo técnico mínimo para implementar PadCoins como sistema de fidelización y canje, separado de:

- XP / liga Arena;
- ranking points / RP;
- rangos;
- puntos de torneo.

Este documento es **solo diseño**. No implica migraciones ejecutadas ni endpoints implementados.

---

## Decisión principal

PadCoins será una **moneda interna de fidelización**.

- No reemplaza XP.
- No reemplaza ranking points.
- No reemplaza rangos.
- No tiene valor económico directo.
- No se muestra como saldo en dinero.

Cada sistema conserva su propósito:

| Sistema | Propósito |
|---------|-----------|
| XP + liga Arena | progresión competitiva / ARENA |
| Rango ARENA | hitos por logros desbloqueados |
| Ranking points (RP) | posición en rankings club / nacional / FIPA |
| Puntos de torneo | clasificación dentro de un torneo |
| **PadCoins** | fidelización, recompensas y canje en sede |

---

## Tablas propuestas

### padcoins_saldo

Campos sugeridos:

- `id`
- `user_id`
- `disponible`
- `historico_total`
- `created_at`
- `updated_at`

Uso:

- `disponible` baja cuando el jugador canjea;
- `historico_total` **no baja** y sirve para nivel / progreso / badges futuros.

Restricciones sugeridas:

- `UNIQUE (user_id)`
- `disponible >= 0`
- `historico_total >= 0`

---

### padcoins_movimientos

Campos sugeridos:

- `id`
- `user_id`
- `tipo`
- `monto`
- `saldo_antes`
- `saldo_despues`
- `referencia_tipo`
- `referencia_id`
- `sede_id`
- `descripcion`
- `created_at`
- `created_by`

Tipos sugeridos (`tipo`):

- `earn`
- `spend`
- `adjust`
- `reverse`

Origen sugerido (`referencia_tipo`):

- `reserva_jugada`
- `partido_jugado`
- `torneo_jugado`
- `torneo_ganado`
- `logro_desbloqueado`
- `invitacion_efectiva`
- `bonus_admin`
- `canje_premio`
- `penalizacion`

Reglas:

- Todo cambio de saldo **debe** insertar una fila aquí (append-only).
- `monto` positivo en `earn`, negativo en `spend` / `penalizacion`, o usar signo consistente documentado en el servicio central.
- `reverse` apunta al movimiento original vía `referencia_id`.

---

### premios_canjeables

Campos sugeridos:

- `id`
- `sede_id`
- `nombre`
- `descripcion`
- `costo_padcoins`
- `stock_total`
- `stock_disponible`
- `activo`
- `fecha_inicio`
- `fecha_fin`
- `condiciones`
- `created_at`
- `updated_at`

Uso:

- Catálogo de premios **canjeables** por sede (distinto de premios descriptivos actuales en `logros_premios` / `ligas_premios`).
- `stock_disponible` decrementa al canjear; puede reponerse por admin.

---

### padcoins_canjes

Campos sugeridos:

- `id`
- `user_id`
- `sede_id`
- `premio_id`
- `monto_padcoins`
- `estado`
- `codigo`
- `created_at`
- `updated_at`
- `entregado_at`
- `entregado_por`

Estados sugeridos:

- `pendiente`
- `aprobado`
- `entregado`
- `cancelado`
- `vencido`

Reglas:

- `codigo` lo genera el **backend** al crear el canje (no la app).
- Un canje exitoso siempre tiene movimiento `spend` asociado y fila en esta tabla.

---

## Reglas V1 para sumar PadCoins

Montos sugeridos (configurables; fuente única en backend):

| Evento | PadCoins |
|--------|----------|
| completar perfil | 250 |
| primera reserva jugada | 500 |
| reserva jugada | 150 |
| partido jugado | 150 |
| partido ganado | 100 |
| cargar resultado válido | 75 |
| primer torneo jugado | 750 |
| participar en torneo | 250 |
| completar fase de grupos | 500 |
| campeón torneo | 1500 |
| subcampeón torneo | 1000 |
| tercer puesto | 750 |
| invitación efectiva | 500 |
| 5 partidos jugados | 750 |
| 10 partidos jugados | 1500 |
| 25 partidos jugados | 3000 |
| 3 semanas seguidas jugando | 1500 |
| cancelación tardía | -200 |
| no show | -500 |

Notas:

- Eventos de **hito** (5/10/25 partidos, 3 semanas) deben ser **idempotentes** (una sola vez por usuario).
- Penalizaciones usan `tipo=spend` o `tipo=earn` con monto negativo según convención del servicio central.
- Las reglas viven en **un módulo de configuración backend** (`padcoinsConfig.js` o similar), no en la app nativa.

---

## Reglas de canje

- El jugador solo puede canjear si tiene saldo `disponible` suficiente.
- El premio debe estar `activo` y dentro de `fecha_inicio` / `fecha_fin`.
- El premio debe tener `stock_disponible > 0`.
- El canje genera movimiento `spend` en `padcoins_movimientos`.
- El canje queda registrado en `padcoins_canjes` con estado inicial `pendiente`.
- La sede puede marcarlo como `entregado` (con `entregado_at` y `entregado_por`).
- Todo canje debe tener historial auditable (movimiento + fila de canje).
- Canje y descuento de stock deben ser **atómicos** (transacción DB o RPC).

---

## Relación con módulos actuales

### XP Arena

- Sigue existiendo sin cambios (`jugadores_perfil.xp`, `xp_transacciones`, `sumar_xp`).
- Desbloquear logros puede seguir sumando XP **y**, en V1, opcionalmente PadCoins en paralelo.
- **No convertir** XP ↔ PadCoins.

### Ranking points (RP)

- Siguen en `rankings_leaderboard` y flujos de torneo (`tabla_puntos`, `equipos.puntos_ranking`).
- RP miden rendimiento competitivo; PadCoins miden fidelización.
- **No usar** RP para canje.

### Rangos ARENA

- Siguen en `jugadores_perfil.rango`, `rangos_historial`, `GET /api/rangos/mi-rango`.
- Independientes del saldo PadCoins.

### Premios actuales (`logros_premios`, `ligas_premios`)

- Pueden **convivir**: son copy descriptivo por sede al desbloquear logro o alcanzar liga.
- V1 de PadCoins agrega **`premios_canjeables`** con costo y stock.
- Migración futura opcional: enlazar un premio descriptivo a un `premio_id` canjeable.

### Cálculo actual de PadCoins en `GET tabla-puntos`

- Hoy `server.js` expone `padcoins` **calculados al vuelo** por posición (`calcPadcoinsPorPosicion`).
- **No persisten** ni alimentan saldo.
- En V1 real: reemplazar ese campo calculado por movimientos reales al finalizar torneo / podio, o marcar el campo legacy como deprecated.

### Quantum / hardcode nativo

- PadCoins V1 **no debe depender** de valores hardcodeados en la app.
- Toda acreditación pasa por servicio backend + movimiento.

### Torneos

- Pueden **mostrar** PadCoins ganadas solo cuando exista movimiento real en `padcoins_movimientos`.
- Finalizar torneo / cargar resultado manual pueden disparar eventos (`torneo_ganado`, `cargar resultado válido`) en fases posteriores a V1 mínima.

---

## Endpoints sugeridos V1

Sin implementar en este RFC. Prefijo y auth alineados con patrones actuales (JWT + `user_roles` para admin sede).

### Jugador

| Método | Ruta | Descripción |
|--------|------|-------------|
| GET | `/api/padcoins/mi-saldo` | `{ disponible, historico_total }` |
| GET | `/api/padcoins/historial` | Lista paginada de `padcoins_movimientos` |
| GET | `/api/premios-canjeables?sede_id=` | Catálogo activo con stock |
| POST | `/api/premios-canjeables/:id/canjear` | Canje atómico; devuelve `{ canje, codigo, saldo }` |
| GET | `/api/padcoins/mis-canjes` | Canjes del usuario (filtro por estado opcional) |

### Admin sede

| Método | Ruta | Descripción |
|--------|------|-------------|
| GET | `/api/admin/premios-canjeables` | CRUD scope sede |
| POST | `/api/admin/premios-canjeables` | Alta premio |
| PUT | `/api/admin/premios-canjeables/:id` | Edición / stock / activo |
| POST | `/api/admin/padcoins-canjes/:id/entregar` | Marca `entregado` |
| POST | `/api/admin/padcoins/ajuste` | Ajuste manual (`adjust`) con motivo |

Auth admin: reutilizar patrón de `logrosPremios.js` (`admin_club` sede / `super_admin`).

---

## Riesgos a evitar

- Mezclar PadCoins con XP en la misma columna o DTO sin nombres claros.
- Mezclar PadCoins con ranking points o `puntos_ranking` de torneo.
- Mostrar PadCoins como dinero o equivalente ARS/USD.
- Canjes sin fila en `padcoins_movimientos`.
- Premios sin control de stock (sobre-canje).
- Códigos de canje generados solo en la app (debe ser backend).
- Reglas de montos duplicadas entre frontend y backend.
- Acreditaciones sin idempotencia (doble suma por mismo evento).
- Depender del campo `padcoins` calculado en `tabla-puntos` como si fuera saldo real.

---

## Primera implementación recomendada

Orden sugerido:

1. Migraciones de tablas (`padcoins_saldo`, `padcoins_movimientos`, `premios_canjeables`, `padcoins_canjes`).
2. Servicio central `acreditarPadcoins` / `descontarPadcoins` (transaccional, idempotente por `referencia_tipo` + `referencia_id`).
3. Endpoints jugador: saldo e historial.
4. Premios canjeables por sede (admin + listado público).
5. Canje con historial y código backend.
6. Conectar **solo 3 eventos iniciales**:
   - reserva jugada;
   - partido jugado;
   - logro desbloqueado.

Después de validar en staging: torneos, penalizaciones, hitos de partidos, completar perfil.

Servicio sugerido: `lib/padcoins/padcoinsService.js` (análogo a `src/xp/xpService.js`).

---

## Fuera de V1

- Marketplace global.
- Transferencia entre usuarios.
- Equivalencia monetaria.
- Campañas complejas.
- Promociones cruzadas entre sedes.
- Integración con billeteras externas.
- Conversión XP ↔ PadCoins.
- Ranking basado en PadCoins.

---

## Referencias en backend actual (solo lectura)

| Módulo existente | Archivo | Relación con PadCoins V1 |
|------------------|---------|---------------------------|
| XP | `src/xp/xpService.js` | Paralelo; no modificar comportamiento |
| Logros sync | `src/arena/logrosSyncService.js` | Hook futuro para `logro_desbloqueado` |
| Premios texto | `routes/logrosPremios.js` | Convive; no reemplaza |
| PadCoins calculado | `server.js` `calcPadcoinsPorPosicion` | Deprecar cuando exista persistencia |
| Reservas cron | `src/cron/reservasCron.js` | Hook futuro para `reserva_jugada` |

---

## Estado del documento

- **Versión:** V1 draft
- **Implementación:** pendiente
- **Aprobación:** pendiente producto / backend
