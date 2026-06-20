# RFC: Match Summary IA v1

**Estado:** Propuesto (no implementado)  
**Repo:** padbol-backend  
**Versión del contrato:** `1.0.0`  
**Skill IA:** `match-summary@1.0.0`  
**Fecha:** 2026-06-02

---

## Resumen ejecutivo

Match Summary IA v1 genera un **texto breve y factual** post-partido para partidos casuales (`partidos_abiertos`), usando **únicamente datos persistidos y confirmados**. No reutiliza el prompt de Chivi general. Usa una skill dedicada `match-summary` y un payload JSON determinístico construido en servidor.

**Fuera de alcance v1:** torneos legacy (`partidos`), scoreboard en vivo, narrativa de jugadas, estadísticas inferidas, integración con cámaras.

---

## 1. Alcance v1

| Incluido | Excluido |
|----------|----------|
| Tabla `partidos_abiertos` | Tabla `partidos` (torneos legacy) |
| Resultado confirmado (dual-captain) | Resultado pendiente o en disputa |
| Skill `match-summary` dedicada | Skill `chivi-general` |
| Resumen factual (1 título + 1–2 párrafos) | Relato deportivo, MVPs, momentos clave |
| Cache opcional en DB | Regeneración en cada request sin control |
| Participantes autenticados | Resumen público anónimo |

### Principios

1. **Solo datos reales:** el modelo recibe un JSON server-side; no consulta libre a DB desde el prompt.
2. **Sin inventar jugadas:** prohibido remates, rallies, aces, errores, duración o sets no presentes en el payload.
3. **Determinismo primero:** el payload se construye con la misma lógica que `mapPartidoDetail` + normalización de resultado.
4. **Fail closed:** si faltan datos mínimos o el partido no está confirmado, no se genera resumen IA.

---

## 2. Precondiciones

Todas deben cumplirse para invocar generación (o devolver cache válido):

| # | Condición | Fuente |
|---|-----------|--------|
| P1 | `partidos_abiertos.estado === 'finalizado'` | DB |
| P2 | `resultado_json.estado_confirmacion === 'confirmado'` | DB |
| P3 | `resultado` y `ganador` presentes | DB |
| P4 | Al menos 2 jugadores en roster (`partidos_abiertos_jugadores`) | DB |
| P5 | Usuario autenticado es participante (`capitan_user_id` o fila en jugadores) **o** admin sede/global autorizado | Auth |
| P6 | Partido ya ocurrió (`fecha` + `hora` ≤ now) | `resultadoService.isMatchPast` |

### Casos que bloquean generación

| Estado | HTTP sugerido | Comportamiento |
|--------|---------------|----------------|
| `en_disputa` | `409 Conflict` | No generar; mensaje fijo sin IA |
| `pendiente` (falta confirmación capitán) | `409 Conflict` | No generar |
| `completo` sin resultado | `409 Conflict` | No generar |
| Usuario no participante | `403 Forbidden` | No generar |
| Partido no encontrado | `404 Not Found` | — |
| Payload incompleto tras normalización | `422 Unprocessable Entity` | No llamar IA |

---

## 3. MatchSummaryPayload JSON

Payload **interno** (servidor → skill IA). No se expone completo al cliente salvo debug admin.

### Schema (`MatchSummaryPayload` v1.0.0)

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "$id": "padbol-match-summary-payload/1.0.0",
  "type": "object",
  "required": [
    "schema_version",
    "partido_id",
    "contexto",
    "equipos",
    "resultado",
    "confirmacion",
    "disclaimers"
  ],
  "properties": {
    "schema_version": { "const": "1.0.0" },
    "partido_id": { "type": "integer", "minimum": 1 },
    "contexto": {
      "type": "object",
      "required": ["deporte", "sede_nombre", "fecha", "hora"],
      "properties": {
        "deporte": { "type": "string", "examples": ["padbol", "padel"] },
        "sede_id": { "type": ["integer", "null"] },
        "sede_nombre": { "type": "string" },
        "sede_ciudad": { "type": ["string", "null"] },
        "cancha": { "type": ["string", "null"] },
        "fecha": { "type": "string", "format": "date" },
        "hora": { "type": "string", "pattern": "^\\d{2}:\\d{2}$" },
        "nivel": { "type": ["string", "null"] },
        "reserva_id": { "type": ["integer", "null"] }
      }
    },
    "equipos": {
      "type": "object",
      "required": ["equipo1", "equipo2", "derivacion"],
      "properties": {
        "derivacion": {
          "type": "string",
          "const": "joined_at_split",
          "description": "Equipos inferidos por orden joined_at; no asignación explícita en DB v1"
        },
        "equipo1": { "$ref": "#/$defs/equipo" },
        "equipo2": { "$ref": "#/$defs/equipo" }
      }
    },
    "resultado": { "$ref": "#/$defs/resultado_normalizado" },
    "confirmacion": {
      "type": "object",
      "required": ["estado", "confirmado_at"],
      "properties": {
        "estado": { "const": "confirmado" },
        "confirmado_at": { "type": "string", "format": "date-time" },
        "capitanes_user_ids": {
          "type": "array",
          "items": { "type": "string", "format": "uuid" },
          "minItems": 1,
          "maxItems": 2
        }
      }
    },
    "xp_opcional": {
      "type": ["object", "null"],
      "properties": {
        "xp_otorgado_partido": { "type": "boolean" },
        "tipos": {
          "type": "array",
          "items": { "type": "string" },
          "examples": [["PARTIDO_CASUAL_CONFIRMADO", "VICTORIA_CASUAL", "CARGAR_RESULTADO"]]
        },
        "liga_por_jugador": {
          "type": "array",
          "items": {
            "type": "object",
            "properties": {
              "user_id": { "type": "string" },
              "liga": { "type": "string" }
            }
          }
        }
      }
    },
    "scoreboard_opcional": {
      "type": ["object", "null"],
      "description": "Reservado v2; null en v1",
      "properties": {
        "scoreboard_partido_id": { "type": "string", "format": "uuid" },
        "sets": { "type": "array" },
        "duracion_segundos": { "type": ["integer", "null"] }
      }
    },
    "disclaimers": {
      "type": "object",
      "required": ["equipos_derivados", "sin_estadisticas"],
      "properties": {
        "equipos_derivados": { "type": "string" },
        "sin_estadisticas": { "type": "string" },
        "resultado_cargado_por_capitanes": { "type": "string" }
      }
    }
  },
  "$defs": {
    "jugador": {
      "type": "object",
      "required": ["user_id", "nombre_display"],
      "properties": {
        "user_id": { "type": "string", "format": "uuid" },
        "nombre_display": { "type": "string", "maxLength": 80 },
        "nivel": { "type": ["string", "null"] },
        "es_capitan": { "type": "boolean" }
      }
    },
    "equipo": {
      "type": "object",
      "required": ["jugadores"],
      "properties": {
        "jugadores": {
          "type": "array",
          "items": { "$ref": "#/$defs/jugador" },
          "minItems": 1,
          "maxItems": 2
        }
      }
    },
    "resultado_normalizado": {
      "type": "object",
      "required": ["formato", "ganador", "marcador_texto"],
      "properties": {
        "formato": {
          "enum": ["puntos_agregados", "sets"]
        },
        "ganador": { "enum": ["equipo1", "equipo2"] },
        "marcador_texto": {
          "type": "string",
          "description": "Representación humana canónica, ej. '6-4' o '2-1 (6-4, 4-6, 6-3)'",
          "maxLength": 120
        },
        "puntos_agregados": {
          "type": ["object", "null"],
          "properties": {
            "equipo1": { "type": "integer", "minimum": 0 },
            "equipo2": { "type": "integer", "minimum": 0 }
          }
        },
        "sets": {
          "type": ["object", "null"],
          "properties": {
            "equipo1_sets": { "type": "integer", "minimum": 0, "maximum": 3 },
            "equipo2_sets": { "type": "integer", "minimum": 0, "maximum": 3 },
            "sets_detalle": {
              "type": "array",
              "items": {
                "type": "object",
                "required": ["equipo1", "equipo2"],
                "properties": {
                  "equipo1": { "type": "integer", "minimum": 0 },
                  "equipo2": { "type": "integer", "minimum": 0 }
                }
              }
            }
          }
        },
        "fuente": {
          "enum": ["dual_captain", "sets_legacy_endpoint"]
        }
      }
    }
  }
}
```

### Ejemplo concreto (puntos agregados — flujo principal)

```json
{
  "schema_version": "1.0.0",
  "partido_id": 12847,
  "contexto": {
    "deporte": "padbol",
    "sede_id": 12,
    "sede_nombre": "Padbol Club Palermo",
    "sede_ciudad": "Buenos Aires",
    "cancha": "2",
    "fecha": "2026-06-01",
    "hora": "20:30",
    "nivel": "intermedio",
    "reserva_id": 99001
  },
  "equipos": {
    "derivacion": "joined_at_split",
    "equipo1": {
      "jugadores": [
        { "user_id": "a1b2c3d4-0000-4000-8000-000000000001", "nombre_display": "Ana", "nivel": "intermedio", "es_capitan": true },
        { "user_id": "a1b2c3d4-0000-4000-8000-000000000002", "nombre_display": "Bruno", "nivel": "intermedio", "es_capitan": false }
      ]
    },
    "equipo2": {
      "jugadores": [
        { "user_id": "a1b2c3d4-0000-4000-8000-000000000003", "nombre_display": "Carla", "nivel": "avanzado", "es_capitan": true },
        { "user_id": "a1b2c3d4-0000-4000-8000-000000000004", "nombre_display": "Diego", "nivel": "intermedio", "es_capitan": false }
      ]
    }
  },
  "resultado": {
    "formato": "puntos_agregados",
    "ganador": "equipo1",
    "marcador_texto": "6-4",
    "puntos_agregados": { "equipo1": 6, "equipo2": 4 },
    "sets": null,
    "fuente": "dual_captain"
  },
  "confirmacion": {
    "estado": "confirmado",
    "confirmado_at": "2026-06-01T22:05:00.000Z",
    "capitanes_user_ids": [
      "a1b2c3d4-0000-4000-8000-000000000001",
      "a1b2c3d4-0000-4000-8000-000000000003"
    ]
  },
  "xp_opcional": {
    "xp_otorgado_partido": true,
    "tipos": ["PARTIDO_CASUAL_CONFIRMADO", "VICTORIA_CASUAL"],
    "liga_por_jugador": [
      { "user_id": "a1b2c3d4-0000-4000-8000-000000000001", "liga": "GOLD" }
    ]
  },
  "scoreboard_opcional": null,
  "disclaimers": {
    "equipos_derivados": "Los equipos se armaron por orden de unión al partido.",
    "sin_estadisticas": "No hay estadísticas ni jugada a jugada registradas para este partido.",
    "resultado_cargado_por_capitanes": "Marcador confirmado por ambos capitanes en Padbol Match."
  }
}
```

---

## 4. MatchSummaryResponse JSON

Respuesta pública de `GET /api/partidos/:id/resumen`.

### Schema (`MatchSummaryResponse` v1.0.0)

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "$id": "padbol-match-summary-response/1.0.0",
  "type": "object",
  "required": [
    "version",
    "partido_id",
    "generated_at",
    "cached",
    "title",
    "summary",
    "highlights",
    "disclaimers",
    "source_fields_used"
  ],
  "properties": {
    "version": { "const": "1.0.0" },
    "partido_id": { "type": "integer" },
    "generated_at": { "type": "string", "format": "date-time" },
    "cached": { "type": "boolean" },
    "prompt_version": { "type": "string", "examples": ["match-summary@1.0.0"] },
    "payload_hash": { "type": "string", "pattern": "^sha256:[a-f0-9]{64}$" },
    "title": { "type": "string", "maxLength": 120 },
    "summary": { "type": "string", "maxLength": 600 },
    "highlights": {
      "type": "array",
      "maxItems": 3,
      "items": {
        "type": "object",
        "required": ["type", "text"],
        "properties": {
          "type": { "enum": ["resultado", "contexto", "equipos"] },
          "text": { "type": "string", "maxLength": 160 }
        }
      },
      "description": "v1: solo hechos derivados del payload; no jugadas"
    },
    "disclaimers": {
      "type": "array",
      "items": { "type": "string", "maxLength": 200 },
      "minItems": 1
    },
    "source_fields_used": {
      "type": "array",
      "items": { "type": "string" },
      "description": "Trazabilidad: claves del payload efectivamente usadas",
      "examples": [["contexto.sede_nombre", "resultado.marcador_texto", "equipos.equipo1.jugadores"]]
    },
    "resultado_eco": {
      "type": "object",
      "description": "Eco mínimo del marcador para UI sin re-fetch partido",
      "properties": {
        "ganador": { "enum": ["equipo1", "equipo2"] },
        "marcador_texto": { "type": "string" }
      }
    }
  }
}
```

### Ejemplo concreto

```json
{
  "version": "1.0.0",
  "partido_id": 12847,
  "generated_at": "2026-06-01T22:06:12.000Z",
  "cached": false,
  "prompt_version": "match-summary@1.0.0",
  "payload_hash": "sha256:abc123...",
  "title": "Victoria de Ana y Bruno en Padbol Club Palermo",
  "summary": "Partido de padbol nivel intermedio en cancha 2. Ana y Bruno vencieron a Carla y Diego por 6-4. Resultado confirmado por ambos capitanes en Padbol Match.",
  "highlights": [
    { "type": "resultado", "text": "Marcador final: 6-4 a favor del equipo 1." },
    { "type": "contexto", "text": "Padbol Club Palermo — 1 jun 2026, 20:30." },
    { "type": "equipos", "text": "Equipo ganador: Ana y Bruno." }
  ],
  "disclaimers": [
    "Resumen generado a partir de datos cargados en la app.",
    "No incluye estadísticas ni jugadas no registradas.",
    "Los equipos se armaron por orden de unión al partido."
  ],
  "source_fields_used": [
    "contexto.deporte",
    "contexto.sede_nombre",
    "contexto.cancha",
    "contexto.fecha",
    "contexto.hora",
    "contexto.nivel",
    "equipos.equipo1.jugadores",
    "equipos.equipo2.jugadores",
    "resultado.marcador_texto",
    "resultado.ganador",
    "confirmacion.estado"
  ],
  "resultado_eco": {
    "ganador": "equipo1",
    "marcador_texto": "6-4"
  }
}
```

### Reglas de `highlights` en v1

- **Permitido:** reformular resultado, sede/fecha, nombres de ganadores.
- **Prohibido:** tipo `jugada`, `mvp`, `estadistica` en v1.
- Si el payload no trae sets → no crear highlight de sets.

---

## 5. Resultado normalizado

### Fuentes en DB hoy

| Origen | Ubicación | Forma |
|--------|-----------|-------|
| Dual-captain (primario) | `resultado` + `resultado_json.cargas` | `{ equipo1: number, equipo2: number }` |
| Legacy sets endpoint | `POST /api/partidos-abiertos/:id/resultado` | `{ equipo1_sets, equipo2_sets, sets_detalle: [{ eq1, eq2 }] }` |
| Disputa | `resultado_json.estado_confirmacion === 'en_disputa'` | No normalizar para IA |

### Algoritmo de normalización (`normalizePartidoResultado`)

```
INPUT: partido.resultado, partido.resultado_json, partido.ganador

1. Si resultado_json.estado_confirmacion !== 'confirmado':
   → ERROR (no normalizar)

2. Si resultado tiene equipo1_sets AND equipo2_sets (números finitos):
   → formato = 'sets'
   → sets = { equipo1_sets, equipo2_sets, sets_detalle normalizado }
   → sets_detalle[i] = { equipo1: eq1|equipo1, equipo2: eq2|equipo2 }
   → marcador_texto = "{equipo1_sets}-{equipo2_sets}"
   → Si sets_detalle.length > 0:
        append " ({d1}, {d2}, ...)" con cada set
   → fuente = 'sets_legacy_endpoint'

3. Else if resultado tiene equipo1 AND equipo2 (números finitos, no sets keys):
   → formato = 'puntos_agregados'
   → puntos_agregados = { equipo1, equipo2 }
   → sets = null
   → marcador_texto = "{equipo1}-{equipo2}"
   → fuente = 'dual_captain'

4. Else if solo resultado_json.cargas con consenso (estado confirmado):
   → tomar cualquier carga de capitán (ya validadas iguales al confirmar)
   → aplicar paso 3

5. Else:
   → ERROR 422 (datos insuficientes)

6. ganador:
   → usar partido.ganador si presente
   → else inferir de marcador (empate → ERROR 422)

OUTPUT: resultado_normalizado
```

### Tabla de decisión

| `resultado` en DB | `formato` | `marcador_texto` ejemplo |
|-------------------|-----------|--------------------------|
| `{ equipo1: 6, equipo2: 4 }` | `puntos_agregados` | `6-4` |
| `{ equipo1_sets: 2, equipo2_sets: 1, sets_detalle: [{eq1:6,eq2:4},{eq1:3,eq2:6},{eq1:6,eq2:2}] }` | `sets` | `2-1 (6-4, 3-6, 6-2)` |

### Notas de compatibilidad

- v1 **prioriza** partidos confirmados por dual-captain (flujo `POST /api/partidos/:id/resultado`).
- Partidos cargados solo por legacy sets sin dual-captain quedan **fuera de alcance v1** salvo extensión explícita (agregar `estado_confirmacion: 'confirmado'` sintético o migración).
- El RFC recomienda **unificar** carga de resultado en `resultadoService` antes de producción.

---

## 6. Endpoint propuesto

### `GET /api/partidos/:id/resumen`

| Aspecto | Detalle |
|---------|---------|
| Auth | Bearer JWT (mismo middleware que `/api/partidos/:id`) |
| Idempotencia | Sí; cache por `payload_hash` |
| Rate limit | Recomendado: 10 req/min/usuario/partido |

### Flujo

```
1. Autenticar usuario
2. Cargar partido_abierto + jugadores + perfiles
3. Verificar participación (o admin)
4. Verificar precondiciones P1–P6
5. Construir MatchSummaryPayload
6. payload_hash = sha256(canonical_json(payload))
7. Si resumen_ia cacheado con mismo hash → 200 cached=true
8. Else llamar skill match-summary → validar respuesta → persistir → 200 cached=false
```

### Códigos HTTP

| Código | Condición | Body ejemplo |
|--------|-----------|--------------|
| `200 OK` | Resumen disponible (nuevo o cache) | `MatchSummaryResponse` |
| `202 Accepted` | **Futuro:** generación async en cola | `{ "status": "pending", "job_id": "..." }` |
| `403 Forbidden` | Usuario no participante ni admin | `{ "error": "No tenés acceso a este resumen" }` |
| `404 Not Found` | Partido inexistente | `{ "error": "Partido no encontrado" }` |
| `409 Conflict` | No confirmado / en disputa / no finalizado | `{ "error": "...", "estado_confirmacion": "en_disputa" }` |
| `422 Unprocessable Entity` | Payload no normalizable | `{ "error": "Datos insuficientes para generar resumen" }` |
| `503 Service Unavailable` | Provider IA caído (sin cache) | `{ "error": "No pudimos generar el resumen" }` |

### v1 vs async

- **v1:** solo `200` síncrono con timeout provider ≤ 8s.
- **v1.1:** `202` + polling; útil si el provider es lento.

---

## 7. Prompt rules (skill `match-summary@1.0.0`)

System prompt (resumen de reglas; implementación en `src/ai/prompts/matchSummaryV1.js`):

1. Recibirás un JSON `MatchSummaryPayload`. **Solo** puedes usar campos presentes en ese JSON.
2. **Prohibido** inventar remates, rallies, aces, errores, MVPs, momentos clave o comentarios de juego.
3. **Prohibido** inferir estadísticas, duración, sets o puntos parciales no incluidos en `resultado`.
4. Si `resultado.formato === 'puntos_agregados'`: no mencionar sets ni games.
5. Si `resultado.sets === null`: no mencionar sets.
6. Si `scoreboard_opcional === null`: no mencionar puntos específicos dentro de un set/game.
7. Si `xp_opcional === null`: no mencionar XP ni liga salvo que esté en el payload.
8. Mencionar equipos usando `nombre_display` sanitizado.
9. Incluir al menos un disclaimer de `disclaimers` del payload (parafraseado breve).
10. **Tono:** breve, positivo, compartible en redes; máximo ~600 caracteres en `summary`.
11. **Salida:** JSON estricto con `title`, `summary`, `highlights`, `disclaimers`, `source_fields_used` (sin markdown).

### Validación post-IA (servidor)

- Rechazar respuesta si `summary` contiene palabras de lista negra no sustentadas: `remate`, `rally`, `ace`, `MVP`, `chilena`, etc. (configurable).
- Verificar que todo nombre de jugador en `summary` ⊆ nombres del payload.
- Verificar longitudes máximas.

---

## 8. Persistencia propuesta

### Opción A: columna `partidos_abiertos.resumen_ia JSONB`

```sql
ALTER TABLE partidos_abiertos
  ADD COLUMN IF NOT EXISTS resumen_ia JSONB;

COMMENT ON COLUMN partidos_abiertos.resumen_ia IS
  'Cache Match Summary IA: { version, payload_hash, generated_at, prompt_version, response }';
```

| Pros | Contras |
|------|---------|
| Lectura en un query con el partido | Mezcla cache IA con entidad de partido |
| Migración mínima | Regeneraciones / auditoría menos claras |
| Alineado a `resultado_json` ya en la misma tabla | JSONB crece si se guardan múltiples versiones |

### Opción B: tabla `partido_resumenes`

```sql
CREATE TABLE partido_resumenes (
  id BIGSERIAL PRIMARY KEY,
  partido_id BIGINT NOT NULL REFERENCES partidos_abiertos(id) ON DELETE CASCADE,
  version TEXT NOT NULL DEFAULT '1.0.0',
  payload_hash TEXT NOT NULL,
  prompt_version TEXT NOT NULL,
  response JSONB NOT NULL,
  generated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (partido_id, payload_hash)
);
CREATE INDEX idx_partido_resumenes_partido ON partido_resumenes(partido_id, generated_at DESC);
```

| Pros | Contras |
|------|---------|
| Historial de regeneraciones | Join extra en lectura |
| Separación clara IA vs dominio partido | Migración + servicio adicional |
| Facilita auditoría y rollback de prompt | — |
| `UNIQUE(partido_id, payload_hash)` evita duplicados | — |

### Recomendación: **Opción B (`partido_resumenes`)**

**Justificación:**

1. Match Summary es **derivado** del partido, no atributo core como `resultado` o `ganador`.
2. Permite **re-generar** con nuevo `prompt_version` sin pisar silenciosamente cache anterior.
3. Auditoría: comparar respuestas ante cambios de prompt o disputas resueltas.
4. El endpoint hace `SELECT ... ORDER BY generated_at DESC LIMIT 1` con índice; costo negligible.
5. Evita inflar filas de `partidos_abiertos` ya con `resultado`, `resultado_json`, etc.

**Compromiso v1:** guardar solo la **última** fila por `(partido_id, payload_hash)`; no exponer historial al cliente.

---

## 9. Seguridad

| Control | Implementación |
|---------|----------------|
| Auth participante | Reutilizar check de `soy_participante` / query a `partidos_abiertos_jugadores` + `capitan_user_id` |
| Admin sede | Opcional v1.1: rol sede admin puede leer resumen de partidos de su sede |
| No confiar en cliente | `partido_id` solo desde URL; payload **100% server-built** |
| Sanitizar nombres | Strip `\n`, markdown, URLs; max 80 chars; usar `nombre_display` de perfil |
| Cache | `payload_hash = sha256(stableStringify(payload))`; invalidar si cambia resultado |
| IA injection | Nombres sanitizados antes de prompt; salida validada |
| PII | No incluir email/teléfono en payload ni respuesta |
| Skill allowlist | Agregar `match-summary` a `AI_ALLOWED_SKILLS`; no invocable desde cliente directo |
| Endpoint interno | `matchSummaryService` llama provider; cliente solo `GET /resumen` |

---

## 10. Plan de implementación

### Etapa 1 — Payload determinístico
- `src/partidos/matchSummaryPayload.js`
- `src/partidos/normalizePartidoResultado.js`
- Tests: `lib/matchSummaryPayload.test.js` con fixtures dual-captain y sets

### Etapa 2 — Persistencia
- `docs/sql/partido_resumenes_migration.sql`
- `src/partidos/matchSummaryRepository.js`

### Etapa 3 — Prompt / skill
- `src/ai/prompts/matchSummaryV1.js`
- Registrar en `src/ai/prompts/registry.js`
- `src/ai/constants.js`: `match-summary` en skills
- `src/partidos/matchSummaryService.js` (build → IA → validate → persist)

### Etapa 4 — Endpoint
- `GET /api/partidos/:id/resumen` en `routes/partidos.js`
- Tests integración auth + 409/422

### Etapa 5 — App nativa
- Pantalla post-resultado / share card
- Deep link desde push de `reservasCron`

### Etapa 6 — Scoreboard / cámaras (v2+)
- FK opcional `partidos_abiertos.scoreboard_partido_id`
- Enriquecer `scoreboard_opcional` en payload
- Highlights permitidos solo si vienen de `historial_sets` / eventos registrados

---

## Referencias de código existente

| Área | Archivo |
|------|---------|
| Partido detail / equipos | `routes/partidos.js` — `mapPartidoDetail`, `mapPartidoRow` |
| Confirmación dual | `src/partidos/resultadoService.js` — `procesarResultadoPartidoCasual` |
| Sets legacy | `routes/partidos.js` — `validateResultadoPayload` |
| AI gateway | `src/ai/gateway/chatGateway.js`, `src/ai/context/buildServerContext.js` |
| Post-partido cron | `src/cron/reservasCron.js` |
| Scoreboard (v2) | `routes/scoreboard.js`, `docs/sql/scoreboard.sql` |

---

## Changelog del RFC

| Versión | Fecha | Cambios |
|---------|-------|---------|
| 1.0.0 | 2026-06-02 | Borrador inicial |
