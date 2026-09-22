import crypto from 'crypto';

export const FIPA_OFFICIAL_RANKING_SOURCE_URL =
  'https://docs.google.com/spreadsheets/d/1Bv57k5Izof_nTiojFn7Y1seNf5ofQfJPYB9oBup0zdk/gviz/tq?tqx=out:csv&gid=2147420736';

const CACHE_MS = 5 * 60 * 1000;
let cache = null;

const CONTINENT_ALIASES = new Map([
  ['america', 'america'], ['americas', 'america'],
  ['europe', 'europa'], ['europa', 'europa'],
  ['middle east', 'oriente_medio'], ['oriente medio', 'oriente_medio'],
  ['africa', 'africa'], ['asia', 'asia'], ['oceania', 'oceania'],
]);

function normalizeText(value) {
  return String(value ?? '').trim().normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}

export function normalizeFipaContinent(value) {
  return CONTINENT_ALIASES.get(normalizeText(value)) ?? null;
}

export function parseFipaPoints(value) {
  const raw = String(value ?? '').trim();
  if (!raw) return null;
  const normalized = raw.includes(',') ? raw.replace(/\./g, '').replace(',', '.') : raw;
  const number = Number(normalized);
  return Number.isFinite(number) ? number : null;
}

export function parseCsvRows(csv) {
  const rows = [];
  let row = [];
  let field = '';
  let quoted = false;
  const input = String(csv ?? '');
  for (let index = 0; index < input.length; index += 1) {
    const character = input[index];
    if (quoted) {
      if (character === '"' && input[index + 1] === '"') { field += '"'; index += 1; }
      else if (character === '"') quoted = false;
      else field += character;
    } else if (character === '"') quoted = true;
    else if (character === ',') { row.push(field); field = ''; }
    else if (character === '\n') { row.push(field.replace(/\r$/, '')); rows.push(row); row = []; field = ''; }
    else field += character;
  }
  if (field || row.length) { row.push(field.replace(/\r$/, '')); rows.push(row); }
  return rows;
}

function buildSourceKey({ firstName, lastName, country }) {
  return crypto.createHash('sha256')
    .update([firstName, lastName, country].map(normalizeText).join('|')).digest('hex');
}

export function parseFipaOfficialRankingCsv(csv) {
  const rows = parseCsvRows(csv);
  const players = rows.slice(2)
    .map((cells, index) => ({ cells, sourceRow: index + 3 }))
    .filter(({ cells }) => /^\d+$/.test(String(cells[0] ?? '').trim())
      && Boolean(String(cells[3] ?? '').trim()) && Boolean(String(cells[4] ?? '').trim()))
    .map(({ cells, sourceRow }) => {
      const nombre = String(cells[3]).trim();
      const apellido = String(cells[4]).trim();
      const pais = String(cells[5] ?? '').trim();
      return {
        source_key: buildSourceKey({ firstName: nombre, lastName: apellido, country: pais }),
        nombre,
        apellido,
        nombre_completo: `${nombre} ${apellido}`.trim(),
        pais: pais || null,
        continente: normalizeFipaContinent(cells[6]),
        posicion: Number(cells[0]),
        puntos: parseFipaPoints(cells[7]),
        detalle: { fila_fuente: sourceRow },
      };
    })
    .filter((player) => player.puntos != null && player.continente);
  return { updatedLabel: String(rows[0]?.[6] ?? '').trim() || null, players };
}

export function filterOfficialFipaRanking(players, continent) {
  const normalized = continent ? normalizeFipaContinent(continent) : null;
  if (continent && !normalized) return null;
  const rows = (normalized ? players.filter((player) => player.continente === normalized) : [...players])
    .sort((a, b) => a.posicion - b.posicion || a.detalle.fila_fuente - b.detalle.fila_fuente);
  if (!normalized) return rows;
  let position = 0;
  let previousWorldPosition = null;
  return rows.map((player) => {
    if (player.posicion !== previousWorldPosition) position += 1;
    previousWorldPosition = player.posicion;
    return { ...player, posicion_mundial: player.posicion, posicion: position };
  });
}

function toDto(player) {
  return {
    fipa_source_key: player.source_key,
    user_id: null,
    nombre: player.nombre,
    apellido: player.apellido,
    display_name: player.nombre_completo,
    pais: player.pais,
    continente: player.continente,
    posicion: player.posicion,
    posicion_mundial: player.posicion_mundial ?? player.posicion,
    puntos: player.puntos,
    puntos_total: player.puntos,
    ranking_origen: 'fipa_oficial',
    ranking_oficial: true,
  };
}

async function loadSource(fetchImpl) {
  const now = Date.now();
  if (cache && now - cache.loadedAt < CACHE_MS) return cache;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 12000);
  try {
    const response = await fetchImpl(FIPA_OFFICIAL_RANKING_SOURCE_URL, {
      signal: controller.signal,
      headers: { accept: 'text/csv' },
    });
    if (!response.ok) throw new Error(`La fuente oficial respondió HTTP ${response.status}`);
    const csv = await response.text();
    const parsed = parseFipaOfficialRankingCsv(csv);
    if (!parsed.players.length) throw new Error('La fuente oficial no contiene jugadores completos');
    cache = { loadedAt: now, hash: crypto.createHash('sha256').update(csv).digest('hex'), ...parsed };
    return cache;
  } finally {
    clearTimeout(timeout);
  }
}

export function mountFipaOfficialRankingRoutes(app, { fetchImpl = globalThis.fetch } = {}) {
  app.get('/api/fipa/rankings/oficial', async (req, res) => {
    try {
      const source = await loadSource(fetchImpl);
      const filtered = filterOfficialFipaRanking(source.players, req.query.continente);
      if (filtered === null) return res.status(400).json({ error: 'Continente de ranking inválido' });
      return res.json({
        fuente: 'fipa_oficial',
        actualizado: source.updatedLabel,
        total_mundial: source.players.length,
        continente: req.query.continente ? normalizeFipaContinent(req.query.continente) : null,
        rankings: filtered.map(toDto),
      });
    } catch (error) {
      console.error('❌ GET /api/fipa/rankings/oficial:', error.message);
      return res.status(503).json({ error: 'El ranking FIPA no está disponible temporalmente' });
    }
  });
}
