# Manual operativo — Marcador y Torneos

Guía interna. Explica cómo funciona el sistema de torneos y el marcador en Padbol Match.
Al hueso, sin redundancias.

## 1. Resumen ejecutivo

- **Torneos**: organiza equipos, genera partidos (liga, grupos, llave), calcula tabla y define ranking final.
- **Marcador (scoreboard)**: registra el juego en vivo punto a punto y determina el ganador de un partido.
- **Conexión**: el marcador de un partido de torneo, al terminar, vuelca su resultado al partido (`sync`). Con ese resultado, la llave avanza sola: el ganador pasa a la ronda siguiente y se crea el marcador del próximo partido.

## 2. Conceptos principales

| Concepto | Qué es |
|----------|--------|
| **torneo** | Competencia. Tiene `tipo_torneo`: `round_robin`, `grupos`, `grupos_knockout`, `knockout`, `liga_playoff`. |
| **equipos** | Equipos inscriptos a un torneo. |
| **partidos** | Enfrentamientos del torneo. Guardan resultado, estado y posición en la llave. |
| **scoreboard_partidos** | Marcador en vivo de un partido. Puede estar ligado a un partido de torneo (`partido_torneo_id`). |
| **control token** | Clave secreta para operar un marcador (árbitro). Se guarda **hasheada**; el valor en claro solo se muestra al crearlo. |
| **sync** | Proceso que copia el resultado del marcador al partido del torneo. |
| **bracket / llave** | Estructura eliminatoria (semifinales, final, etc.). |
| **partido_siguiente_id** | Partido destino al que avanza el ganador. `null` en la última ronda. |
| **partido_siguiente_slot** | Slot destino: `'A'` → `equipo_a_id`; `'B'` → `equipo_b_id`. |
| **bracket_round** | Profundidad de la ronda. `1` = primera ronda; mayor = más cerca de la final. |
| **bracket_position** | Orden del partido dentro de la ronda (empieza en `1`). |

## 3. Marcador

**Cómo se crea**
- Para torneos: `POST /api/torneos/:id/generar-scoreboards` crea marcadores de los partidos con ambos equipos definidos.
- Automático: cuando la llave completa un partido destino, se crea su marcador solo (ver sección 5).

**Cómo se controla por token**
- Cada marcador tiene un `control_token`. El árbitro opera con ese token.
- El token viaja en la URL de control. No requiere login admin.

**Endpoints principales**

| Método | Endpoint | Uso |
|--------|----------|-----|
| GET | `/api/scoreboard/control/:token` | Ver estado del marcador. |
| POST | `/api/scoreboard/control/:token/punto/:equipo` | Sumar punto (`a` / `b`). |
| POST | `/api/scoreboard/control/:token/undo` | Deshacer último punto. |
| POST | `/api/scoreboard/control/:token/saque` | Cambiar saque. |
| POST | `/api/scoreboard/control/:token/tiebreak` | Marcar tiebreak. |
| POST | `/api/scoreboard/control/:token/cronometro/:accion` | Control de cronómetro. |
| GET | `/api/scoreboard/partidos?sede_id=:sede` | Listar marcadores de una sede. |

**Cómo termina**
- El marcador pasa a `terminado` cuando un equipo gana los sets necesarios.
- Al terminar, dispara el `sync` hacia el partido del torneo (si está ligado).

**Qué guarda**
- Sets, games, historial de puntos, saque, estado, y el resultado final.

**Qué no debe exponerse**
- El `control_token` en claro (solo se entrega al crear el marcador).
- Se persiste `control_token_hash`, nunca el token plano.

## 4. Sync marcador → partido

**Cuándo ocurre**
- Al registrar el punto que finaliza el marcador, si el marcador tiene `partido_torneo_id`.

**Qué actualiza en `partidos`**
- `resultado`: resultado del partido en formato interno.
- `ganador_equipo_id`: id del equipo ganador.
- `estado`: pasa a `finalizado`.
- `sync_torneo_status`: queda en `synced` cuando el volcado fue correcto.

**Nota sobre el formato legacy**
- Internamente el resultado usa `resultado.goles_a` / `resultado.goles_b`.
- Es un **nombre legacy**: representa **sets ganados**, no goles.

**Reglas de seguridad**
- El avance de llave nunca rompe la respuesta del marcador.
- Si el sync falla, se loguea y no corrompe datos.
- No se pisan resultados ya cargados.

## 5. Knockout (llave eliminatoria)

**Generación 4 / 8 / 16 equipos** (`POST /api/torneos/:id/generar-partidos`)

| Equipos | Partidos | Estructura |
|---------|----------|------------|
| 4 | 3 | 2 semifinales + final |
| 8 | 7 | 4 cuartos + 2 semifinales + final |
| 16 | 15 | 8 octavos + 4 cuartos + 2 semifinales + final |

- Cantidad distinta de 4/8/16 → error 400, sin crear fixture parcial.
- Si el torneo ya tiene partidos, no duplica.

**Primera ronda**
- Partidos con equipos reales en `equipo_a_id` / `equipo_b_id`.

**Rondas futuras**
- `equipo_a_id = null` y `equipo_b_id = null` (slots vacíos).
- `estado = 'pendiente'`, `grupo = null`.

**Avance automático**
- Al finalizar un partido, el ganador pasa al `partido_siguiente_id`, en el slot A o B.
- Idempotente: si el ganador ya está, no cambia nada.
- Si el slot está ocupado por otro equipo → `conflict`, no pisa.

**Creación automática de marcador**
- Cuando el partido destino queda con ambos equipos definidos, se crea su marcador solo (`estado = 'pendiente'`, con `control_token`).
- No duplica si ya existe un marcador activo.

**Final sin destino**
- La final tiene `partido_siguiente_id = null`.
- Al finalizarla, el avance devuelve `skipped/no_destino`: no crea nada más.

## 6. Grupos

**Tabla live**
- `GET /api/torneos/:id/tabla` calcula la tabla en lectura desde los partidos finalizados.
- En `grupos` y `grupos_knockout`, separa por grupo (A, B, …).

**Criterios de orden**
1. puntos
2. diferencia de sets
3. sets a favor
4. diferencia de games
5. games a favor
6. nombre del equipo
7. id del equipo

**Qué ya funciona**
- Reparto en grupos y generación de partidos de grupo.
- Tabla por grupo, en vivo.

**Qué falta**
- Avance automático de **grupos → knockout**: hoy la fase de grupos no genera la llave con los clasificados. Está diseñado (RFC aparte), pendiente de implementar.

## 7. Finalización de torneo

- `POST /api/torneos/:id/finalizar` calcula el ranking/clasificación final y lo persiste.
- Según el tipo: liga/grupos usan la tabla; knockout usa el podio (campeón, subcampeón, perdedores por ronda); `grupos_knockout` combina podio eliminatorio + resto por grupos.
- **No conviene re-finalizar torneos históricos**: recalcular puede sobrescribir rankings ya publicados.

## 8. Validaciones reales ya hechas

Demo **#28** (`knockout` 4 equipos), validado de punta a punta en producción:

| Partido | Resultado | Ganador |
|---------|-----------|---------|
| Semifinal #45 | 6-0 / 6-0 | equipo **71** |
| Semifinal #46 | 6-0 / 6-0 | equipo **73** |
| Final #47 | 6-0 / 6-0 | equipo **71** (campeón) |

- Ganadores de semifinales avanzaron solos a la final.
- El marcador de la final se creó automáticamente al quedar completa.
- La final cerró sin avance (`skipped/no_destino`) ni marcadores extra.
- Marcadores del demo: **3** (uno por partido).
- Torneos protegidos intactos: **#21 = 6 partidos, #23 = 16, #27 = 1**.

## 9. Reglas operativas

- No tocar torneos históricos (#21 / #23 / #27, u otros reales) sin autorización explícita.
- No re-finalizar torneos viejos.
- No ejecutar SQL sin confirmar.
- No pegar tokens ni secretos en ChatGPT ni herramientas externas.
- Los scripts `*.local.mjs` son de prueba: no se commitean.
- Datos de prueba siempre con prefijo `DEMO |`.

## 10. Pendientes

- Grupos → knockout automático (generar la llave con los clasificados).
- Campeón / podio más visible en respuestas y pantallas.
- Pantallas de app y panel para la llave y el marcador.
- Prueba E2E completa de un torneo `grupos_knockout` (grupos → semifinales → final).
