# PadCoins — campañas automáticas por sede

## Modelo de producto

- La **sede** crea campañas agresivas bajo su responsabilidad comercial.
- **Super Admin** no aprueba campaña por campaña; define marco global, audita alertas y trazabilidad.
- La conversión administrativa interna (`padcoins_por_usd_equivalente`) es **global**; la sede no la modifica.
- La sede define campañas, beneficios asociados, stock/cupos, vigencia y condiciones.

## Tablas

- `padcoins_campaigns` — definición de campaña
- `padcoins_campaign_audit_logs` — trazabilidad (created, activated, applied, high_impact)
- `padcoins_campaign_applications` — uso por reserva/jugador

Migración: `docs/sql/padcoins_campaigns_migration.sql`

## Tipos de campaña

| Tipo | Efecto |
|------|--------|
| `multiplier` | Multiplica PadCoins base de la reserva |
| `percentage_override` | Recalcula con % temporal fuerte |
| `fixed_padcoins` | Monto fijo por reserva |
| `benefit_equivalent` | PadCoins = costo del beneficio (`premios_canjeables`) |

## Flujo de acreditación reserva

1. Calcular PadCoins **base** con config efectiva (`getPadcoinsReservationConfigForSede`)
2. Resolver campaña activa (`resolveActiveCampaignForReserva`)
3. Aplicar campaña (`applyCampaignToPadcoinsEarn`)
4. `addPadcoins` + registrar `padcoins_campaign_applications`

## Endpoints admin

Base: `/api/admin/padcoins/campaigns`

| Método | Ruta | Permisos |
|--------|------|----------|
| GET | `/` | Super Admin todas; Admin Club su sede |
| GET | `/:id` | Scope sede |
| POST | `/` | Admin Club su sede; Super Admin cualquiera |
| PUT | `/:id` | Scope sede |
| POST | `/:id/activate` | Scope sede; pausa otras activas de la misma sede |
| POST | `/:id/pause` | Scope sede |
| GET | `/:id/summary` | Scope sede |

**Admin Nacional:** sin acceso a este módulo.

## High impact

Umbrales en `PADCOINS_CAMPAIGN_HIGH_IMPACT_THRESHOLDS`. Marca `high_impact=true` y audit log; **no bloquea** creación ni activación.

## Segmentación

`segment_config` JSONB preparado para futuro. Vacío = todos los jugadores elegibles.
