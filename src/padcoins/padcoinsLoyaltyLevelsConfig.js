/**
 * Niveles de fidelización PadCoins (Starter → Legend).
 * Separados del rango deportivo ARENA (Rookie → GOAT) y de ligas XP Arena.
 * El nivel se calcula sobre historico_total; canjear no lo reduce.
 */

export const PADCOINS_LOYALTY_LEVELS = Object.freeze([
  { slug: 'starter', nombre: 'Starter', orden: 1, default_umbral: 0 },
  { slug: 'bronze', nombre: 'Bronze', orden: 2, default_umbral: 500 },
  { slug: 'silver', nombre: 'Silver', orden: 3, default_umbral: 2000 },
  { slug: 'gold', nombre: 'Gold', orden: 4, default_umbral: 5000 },
  { slug: 'platinum', nombre: 'Platinum', orden: 5, default_umbral: 12000 },
  { slug: 'diamond', nombre: 'Diamond', orden: 6, default_umbral: 25000 },
  { slug: 'elite', nombre: 'Elite', orden: 7, default_umbral: 50000 },
  { slug: 'legend', nombre: 'Legend', orden: 8, default_umbral: 100000 },
]);

const SLUG_SET = new Set(PADCOINS_LOYALTY_LEVELS.map((level) => level.slug));

export function isPadcoinsLoyaltyLevelSlug(slug) {
  return SLUG_SET.has(String(slug ?? '').trim().toLowerCase());
}

export function padcoinsLoyaltyLevelConfigKey(slug) {
  const normalized = String(slug ?? '').trim().toLowerCase();
  if (!isPadcoinsLoyaltyLevelSlug(normalized)) {
    return null;
  }
  return `nivel_fidelizacion_${normalized}_umbral`;
}

export function buildDefaultPadcoinsLoyaltyLevelThresholds() {
  return PADCOINS_LOYALTY_LEVELS.map((level) => ({
    slug: level.slug,
    nombre: level.nombre,
    orden: level.orden,
    umbral_minimo: level.default_umbral,
  }));
}

export const PADCOINS_LOYALTY_LEVEL_CONFIG_KEYS = Object.freeze(
  PADCOINS_LOYALTY_LEVELS.map((level) => padcoinsLoyaltyLevelConfigKey(level.slug)),
);
