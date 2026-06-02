export const RANGOS = [
  { slug: 'rookie', nombre: 'Rookie', condicion: 'registro', min_logros: 0 },
  { slug: 'pro', nombre: 'Pro', condicion: 'logros', min_logros: 5 },
  { slug: 'gold', nombre: 'Gold', condicion: 'logros_campeon_local', min_logros: 10 },
  { slug: 'star', nombre: 'Star', condicion: 'logros_campeon_nacional', min_logros: 15 },
  { slug: 'elite', nombre: 'Elite', condicion: 'top10_fipa', min_logros: 15 },
  { slug: 'goat', nombre: 'GOAT', condicion: 'leyenda_fipa', min_logros: 20 },
];

export const XP_SUBIDA_RANGO = {
  pro: 200,
  gold: 500,
  star: 1000,
  elite: 2000,
  goat: 5000,
};

export const XP_TIPO_SUBIDA_RANGO = {
  pro: 'SUBIDA_RANGO_PRO',
  gold: 'SUBIDA_RANGO_GOLD',
  star: 'SUBIDA_RANGO_STAR',
  elite: 'SUBIDA_RANGO_ELITE',
  goat: 'SUBIDA_RANGO_GOAT',
};
