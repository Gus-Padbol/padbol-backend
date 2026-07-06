# PadCoins — alertas Super Admin por uso anormal

PadCoins es moneda de fidelización; **no es dinero** para el jugador.

## Objetivo

Dar al **Super Admin** una base de supervisión para detectar uso indebido, abusivo o poco creíble de PadCoins por sede, **sin bloquear automáticamente** y **sin reemplazar** la atención de reclamos diarios del Admin Club.

| Rol | Responsabilidad |
|-----|-----------------|
| **Admin Club** | Reclamos normales de jugadores de su sede |
| **Super Admin** | Supervisión de abusos / patrones anómalos |

## Endpoint

```
GET /api/admin/padcoins-alertas
```

**Solo Super Admin.** Admin Club y Admin Nacional → `403`.

### Filtros

| Parámetro | Descripción |
|-----------|-------------|
| `sede_id` | Evalúa/filtra una sede |
| `fecha_desde` / `desde` | Inicio del periodo (default: 7 días atrás) |
| `fecha_hasta` / `hasta` | Fin del periodo (default: ahora) |
| `severidad` | `baja`, `media`, `alta` |
| `tipo_alerta` | Ver tipos abajo |
| `limit` | Default 25, max 100 |
| `offset` / `page` | Paginación |

### Respuesta

```json
{
  "ok": true,
  "alertas": [{
    "id": "1:ajustes_manuales_excesivos:...",
    "tipo_alerta": "ajustes_manuales_excesivos",
    "severidad": "media",
    "sede_id": 1,
    "sede_nombre": "La Meca",
    "descripcion": "…",
    "metricas": { },
    "periodo": { "desde": "…", "hasta": "…", "dias": 7 },
    "movimientos_relacionados": [],
    "recomendacion": "…",
    "calculado_en": "…"
  }],
  "paginacion": { "limit", "offset", "page", "total" },
  "filtros_aplicados": { },
  "nota": "Alertas calculadas en tiempo real…"
}
```

## Tipos de alerta

| `tipo_alerta` | Qué detecta |
|---------------|-------------|
| `ajustes_manuales_excesivos` | Muchos `adjust` positivos, monto alto, repetición sobre mismo jugador |
| `canjes_sospechosos` | Muchos canjes en poco tiempo, premios de bajo costo, jugadores repetidos |
| `reservas_padcoins_poco_creible` | Earn alto vs reservas; earn sin referencia clara |
| `penalizaciones_reversas_anormales` | Volumen alto de penalizaciones o reversas de canje |
| `campania_identificada` | Movimientos con marcador de campaña/marketing en descripción (informativo) |

## Criterios iniciales (umbrales)

Configurados en `PADCOINS_ALERT_THRESHOLDS` (`padcoinsAlertsService.js`):

### Ajustes manuales
- ≥ 5 ajustes positivos **sin** keyword de campaña en 7 días, o total ≥ 1500 PC
- Mismo jugador ≥ 3 ajustes → sube severidad
- Ajustes con descripción que incluye `campaña`, `marketing`, `promo`, etc. → **excluidos** del abuso; generan `campania_identificada`

### Canjes sospechosos
- ≥ 8 canjes en 24 h por sede
- ≥ 5 canjes con premio de costo ≤ 80 PC
- Mismo jugador ≥ 3 canjes en el periodo

### Reservas / PadCoins
- ≥ 3 earn sin `referencia_tipo`/`referencia_id` claros y total ≥ 500 PC
- Ratio earn total vs earn por reserva > 3× lo esperable

### Penalizaciones / reversas
- ≥ 8 penalizaciones o ≥ 5 reversas en el periodo

## Severidad

`baja` / `media` / `alta` — calculada por `getPadcoinsAlertSeverity()` según métricas y umbrales.

## Qué NO hace

- **No bloquea** sedes ni jugadores automáticamente
- **No persiste** alertas (v1 calculada en tiempo real)
- **No reemplaza** `GET /api/admin/padcoins-movimientos` ni `/api/padcoins/historial`
- **No usa** lenguaje de dinero/cashback

## Campañas justificadas

**Fase 1 (actual):** detección por keywords en `descripcion` (`campaña`, `marketing`, `promo`, …).

**Fase 2 (pendiente):** el esquema actual **no tiene** `campania_id`, `metadata` ni flag formal en `padcoins_movimientos`. Conviene agregar:

- `campania_id` / `campania_nombre` en movimientos o tabla `padcoins_campanias`
- Tabla `padcoins_alertas` para persistir, ack y workflow Super Admin
- Exclusión automática de movimientos marcados como campaña aprobada

## Persistencia — fase posterior

Se recomienda tabla `padcoins_alertas` cuando haya:

- Acknowledgement por Super Admin
- Historial de alertas resueltas
- Menor costo de recálculo en listados frecuentes

V1: endpoint calculado desde `padcoins_movimientos` + `padcoins_canjes`.

## Servicio

`src/padcoins/padcoinsAlertsService.js`

- `evaluarAlertasPadcoinsPorSede(supabaseAdmin, sedeId, options)`
- `evaluarAlertasPadcoinsGlobal(supabaseAdmin, options)`
- `listPadcoinsAlertasAdmin(supabaseAdmin, { role, query })`
- `buildPadcoinsAlert(...)`, `getPadcoinsAlertSeverity(...)`, `getPadcoinsAlertReason(...)`

## Tests

`lib/padcoinsAlerts.test.js`

## Uso previsto

- Panel Super Admin de supervisión
- Detección temprana de abuso promocional
- Contraste con reclamos puntuales que resuelve cada sede
