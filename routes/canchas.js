function parseSedeId(raw) {
  const sid = parseInt(String(raw ?? '').trim(), 10);
  return Number.isFinite(sid) && sid > 0 ? sid : null;
}

function normalizeDeporte(row) {
  return String(row?.deporte ?? row?.sport ?? row?.tipo_deporte ?? 'padbol').trim().toLowerCase();
}

function enrichCanchaRow(row) {
  return {
    ...row,
    deporte: normalizeDeporte(row),
    nombre: row?.nombre ?? row?.name ?? null,
  };
}

async function fetchCanchasBySedeId(supabaseAdmin, sedeId) {
  const tables = ['canchas', 'cancha'];
  const selectVariants = [
    'id, sede_id, nombre, name, numero, deporte, sport, tipo_deporte, activo, created_at, updated_at',
    'id, sede_id, nombre, name, numero, deporte, sport, tipo_deporte',
    '*',
  ];

  for (const table of tables) {
    for (const selectCols of selectVariants) {
      console.log('[GET /api/canchas] query:', {
        table,
        sede_id: sedeId,
        filter: { sede_id: sedeId },
        select: selectCols,
      });

      const { data, error } = await supabaseAdmin
        .from(table)
        .select(selectCols)
        .eq('sede_id', sedeId)
        .order('id', { ascending: true });

      console.log('[GET /api/canchas] result:', {
        table,
        sede_id: sedeId,
        select: selectCols,
        count: data?.length ?? 0,
        error: error?.message ?? null,
        rows: data ?? [],
      });

      if (error) {
        if (/relation|does not exist|schema cache/i.test(String(error.message || ''))) {
          break;
        }
        if (/colum|column/i.test(String(error.message || ''))) {
          continue;
        }
        throw error;
      }

      return { table, rows: data ?? [] };
    }
  }

  return { table: null, rows: [] };
}

export function mountCanchasRoutes(app, { supabaseAdmin }) {
  app.get('/api/canchas', async (req, res) => {
    try {
      const sedeId = parseSedeId(req.query.sede_id);
      if (!sedeId) {
        return res.status(400).json({ error: 'sede_id query param es requerido' });
      }

      const { table, rows } = await fetchCanchasBySedeId(supabaseAdmin, sedeId);
      const canchas = rows.map(enrichCanchaRow);

      console.log('[GET /api/canchas] response:', {
        sede_id: sedeId,
        table: table ?? 'none',
        count: canchas.length,
      });

      return res.json({ canchas });
    } catch (err) {
      console.error('❌ GET /api/canchas:', err.message);
      return res.status(500).json({ error: err.message || 'Error al obtener canchas' });
    }
  });
}
