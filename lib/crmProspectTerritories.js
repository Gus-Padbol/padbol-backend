// Territory protection is deliberately a separate control from prospect data.
// A territory is protected only when a commercial owner marks it explicitly,
// with a source and reason. Unknown availability stays pending, never blocked.
let ready = false;

export async function ensureTerritoryTable(pool) {
  if (!pool?.query || ready) return Boolean(pool?.query);
  await pool.query(`
    create table if not exists public.crm_prospect_territories (
      territory_key text primary key,
      country text not null,
      region text,
      city text,
      protected boolean not null default true,
      reason text not null,
      source text not null,
      updated_by text,
      updated_at timestamptz not null default now()
    );
    revoke all on public.crm_prospect_territories from public, anon, authenticated;
    grant select, insert, update on public.crm_prospect_territories to service_role;
  `);
  ready = true;
  return true;
}

export function territoryKey({ country, region, city } = {}) {
  const normalize = value => String(value ?? '').trim().toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/\s+/g, ' ');
  return [normalize(country), normalize(region), normalize(city)].filter(Boolean).join('|');
}

export async function protectedTerritoryFor(pool, prospect = {}) {
  if (!pool?.query) return null;
  try {
    await ensureTerritoryTable(pool);
    const key = territoryKey(prospect);
    if (!key) return null;
    const values = [String(prospect.country || '').trim().toLowerCase(), String(prospect.state || prospect.region || '').trim().toLowerCase(), String(prospect.city || '').trim().toLowerCase()];
    const { rows } = await pool.query(
      `select territory_key, country, region, city, protected, reason, source
       from public.crm_prospect_territories
       where protected = true
         and lower(country) = $1
         and (region is null or lower(region) = $2)
         and (city is null or lower(city) = $3)
       order by (city is not null) desc, (region is not null) desc
       limit 1`, values,
    );
    return rows?.[0] || null;
  } catch { return null; }
}

export async function listTerritories(pool) {
  if (!pool?.query) return [];
  await ensureTerritoryTable(pool);
  const { rows } = await pool.query('select * from public.crm_prospect_territories where protected = true order by country, region nulls first, city nulls first');
  return rows || [];
}

export async function saveTerritory(pool, input, actor) {
  if (!pool?.query) throw Object.assign(Error('Territory control unavailable'), { status: 503, code: 'TERRITORY_UNAVAILABLE' });
  await ensureTerritoryTable(pool);
  const country = String(input?.country || '').trim();
  const reason = String(input?.reason || '').trim().slice(0, 500);
  const source = String(input?.source || '').trim().slice(0, 500);
  if (!country || !reason || !source) throw Object.assign(Error('País, motivo y fuente son obligatorios.'), { status: 400, code: 'TERRITORY_INVALID' });
  const region = String(input?.region || '').trim() || null;
  const city = String(input?.city || '').trim() || null;
  const key = territoryKey({ country, region, city });
  const { rows } = await pool.query(
    `insert into public.crm_prospect_territories (territory_key, country, region, city, protected, reason, source, updated_by)
     values ($1,$2,$3,$4,true,$5,$6,$7)
     on conflict (territory_key) do update set protected=true, reason=excluded.reason, source=excluded.source, updated_by=excluded.updated_by, updated_at=now()
     returning *`, [key, country, region, city, reason, source, actor || 'system'],
  );
  return rows?.[0] || null;
}
