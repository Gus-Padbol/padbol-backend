/** Normaliza lista de URLs de fotos de sede. */
export function normalizeSedeFotoUrls(raw) {
  if (!Array.isArray(raw)) return [];
  return raw.map((u) => String(u || '').trim()).filter(Boolean);
}

/**
 * Hero de la sede: `fotos_destacadas[0]` (elegida en admin Mi Sede).
 * Fallback: `foto_url`, luego primera de `fotos_urls`.
 */
export function resolveSedeHeroFotoUrl(sede) {
  const gallery = normalizeSedeFotoUrls(sede?.fotos_urls);
  const destacadas = normalizeSedeFotoUrls(sede?.fotos_destacadas);

  if (destacadas[0]) {
    const hero = destacadas[0];
    if (gallery.length === 0 || gallery.includes(hero)) return hero;
    const loose = gallery.find((u) => u === hero || u.endsWith(hero) || hero.endsWith(u));
    if (loose) return loose;
    return hero;
  }

  if (sede?.foto_url) {
    const legacy = String(sede.foto_url).trim();
    if (legacy) return legacy;
  }

  return gallery[0] ?? null;
}

/** Asegura arrays de fotos y campo derivado `hero_foto_url` en respuestas de sede. */
export function enrichSedeWithHeroPhoto(sede) {
  if (!sede || typeof sede !== 'object') return sede;

  const fotos_urls = normalizeSedeFotoUrls(sede.fotos_urls);
  const fotos_destacadas = normalizeSedeFotoUrls(sede.fotos_destacadas).slice(0, 4);
  const normalized = { ...sede, fotos_urls, fotos_destacadas };

  return {
    ...normalized,
    hero_foto_url: resolveSedeHeroFotoUrl(normalized),
  };
}
