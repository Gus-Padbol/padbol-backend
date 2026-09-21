const SOURCE_URL =
  'https://docs.google.com/spreadsheets/d/1Bv57k5Izof_nTiojFn7Y1seNf5ofQfJPYB9oBup0zdk/gviz/tq?tqx=out:csv&gid=2147420736';

const DISPLAY_NAMES = new Map([
  ['Sardinia', 'Torneo Internacional de Cerdeña'],
  ['Austria', 'Copa de Naciones de Padbol · Austria'],
  ['AC', 'Copa América de Padbol'],
  ['EC', 'Eurocopa de Padbol'],
  ['WC', 'Copa Mundial de Padbol'],
  ['IC', 'Copa Intercontinental de Padbol'],
]);

function parseCsv(csv) {
  const rows = [];
  let row = [];
  let field = '';
  let quoted = false;
  const input = String(csv ?? '');
  for (let index = 0; index < input.length; index += 1) {
    const char = input[index];
    if (quoted) {
      if (char === '"' && input[index + 1] === '"') {
        field += '"';
        index += 1;
      } else if (char === '"') quoted = false;
      else field += char;
    } else if (char === '"') quoted = true;
    else if (char === ',') {
      row.push(field);
      field = '';
    } else if (char === '\n') {
      row.push(field.replace(/\r$/, ''));
      rows.push(row);
      row = [];
      field = '';
    } else field += char;
  }
  if (field || row.length) {
    row.push(field.replace(/\r$/, ''));
    rows.push(row);
  }
  return rows;
}

function displayName(label) {
  const match = String(label || '').trim().match(/^(.+?)\s+(\d{4})$/);
  if (!match) return String(label || '').trim();
  return `${DISPLAY_NAMES.get(match[1]) || match[1]} ${match[2]}`;
}

/**
 * Extrae sólo datos explícitos de la planilla oficial: inventario, jugadores y
 * posiciones 1–3. No inventa fechas, sedes, partidos ni cuentas de usuario.
 */
export function parseOfficialFipaTournamentHistory(csv) {
  const rows = parseCsv(csv);
  const header = rows[0] || [];
  const events = header
    .map((value, index) => ({ label: String(value || '').trim(), index }))
    .filter(({ label, index }) => index >= 8 && /\b\d{4}$/.test(label));

  return events.map(({ label, index }, eventIndex) => {
    const nextIndex = events[eventIndex + 1]?.index ?? header.length;
    const year = Number(label.match(/(\d{4})$/)?.[1]);
    const podium = new Map();
    const participants = new Set();

    for (const cells of rows.slice(2)) {
      const firstName = String(cells[3] || '').trim();
      const lastName = String(cells[4] || '').trim();
      const country = String(cells[5] || '').trim();
      if (!firstName || !lastName) continue;
      const positionRaw = String(cells[index] || '').trim();
      if (cells.slice(index, nextIndex).some((value) => String(value || '').trim())) {
        participants.add(`${firstName}|${lastName}|${country}`);
      }
      if (!/^[123]$/.test(positionRaw)) continue;
      const position = Number(positionRaw);
      if (!podium.has(position)) podium.set(position, []);
      podium.get(position).push({
        display_name: `${firstName} ${lastName}`,
        foto_url: null,
        pais: country || null,
      });
    }

    return {
      id: `fipa-${label.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')}`,
      nombre: displayName(label),
      deporte: 'padbol',
      sede_nombre: 'Circuito internacional FIPA',
      sede_id: null,
      fecha_inicio: null,
      fecha_fin: null,
      formato: 'historico_fipa',
      total_participantes: participants.size,
      podio: [...podium.entries()]
        .sort(([a], [b]) => a - b)
        .map(([posicion, jugadores]) => ({
          posicion,
          equipo_id: null,
          equipo_nombre: [...new Set(jugadores.map((p) => p.pais).filter(Boolean))].join(' / ')
            || `Puesto ${posicion}`,
          jugadores,
        })),
      anio: year,
      origen: 'ranking_fipa_oficial',
    };
  });
}

let cache = null;
const CACHE_MS = 5 * 60 * 1000;

export async function fetchOfficialFipaTournamentHistory() {
  if (cache && Date.now() - cache.loadedAt < CACHE_MS) return cache.rows;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 8000);
  try {
    const response = await fetch(SOURCE_URL, { signal: controller.signal, headers: { accept: 'text/csv' } });
    if (!response.ok) throw new Error(`La fuente FIPA respondió HTTP ${response.status}`);
    const rows = parseOfficialFipaTournamentHistory(await response.text());
    if (rows.length < 13) throw new Error(`La fuente FIPA devolvió sólo ${rows.length} torneos`);
    cache = { loadedAt: Date.now(), rows };
    return rows;
  } finally {
    clearTimeout(timeout);
  }
}
