import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
const club = ['admin_club', 'super_admin'];
const all = ['admin_club', 'admin_cadena', 'admin_nacional', 'super_admin'];
export const HELP_MODULE_ROLE_CEILINGS = Object.freeze({
  administracion: all, sedes: club, reservas: club, validaciones: club,
  torneos: club, marcador: club, jugadores: club, membresias: club,
  incentivos: all, notificaciones: all, soporte: ['super_admin'], configuracion: ['super_admin'],
});
export function reviewHelpCorpus(input) {
  const errors = [], routes = new Set(), ids = new Set();
  if (input?.runtimeEligible === false) errors.push('Corpus explicitly not runtime eligible; review required');
  const articles = Array.isArray(input) ? input : input?.articles;
  if (!Array.isArray(articles) || !articles.length) return [...errors, 'Nonempty articles array required'];
  for (const [index, a] of articles.entries()) {
    const label = a?.id || `article ${index}`;
    if (!a || typeof a !== 'object') { errors.push(`${label}: invalid article`); continue; }
    if (!a.id || ids.has(a.id)) errors.push(`${label}: missing/duplicate id`);
    ids.add(a.id);
    const route = `${a.module}/${a.slug}`;
    if (!/^[a-z0-9-]+\/[a-z0-9-]+$/.test(route) || routes.has(route)) errors.push(`${label}: invalid/duplicate route`);
    routes.add(route);
    const ceiling = HELP_MODULE_ROLE_CEILINGS[a.module];
    if (!ceiling || !Array.isArray(a.allowedRoles) || !a.allowedRoles.length || a.allowedRoles.some(r => !ceiling.includes(r))) errors.push(`${label}: allowedRoles exceed reviewed module policy`);
    if (a.status !== 'reviewed') errors.push(`${label}: reviewed status required`);
    if (!['source-reviewed', 'runtime-verified'].includes(a.verification)) errors.push(`${label}: verification required`);
    if (!a.sourceVersion?.frontend || !a.sourceVersion?.backend || !a.sourceRefs?.length) errors.push(`${label}: source versions and references required`);
    for (const lang of ['es', 'en', 'pt']) {
      const copy = a.translations?.[lang];
      if (!copy || typeof copy.title !== 'string' || !copy.title.trim() || typeof copy.limit !== 'string' || !copy.limit.trim()
        || !['requirements', 'steps'].every(key => Array.isArray(copy[key]) && copy[key].length && copy[key].every(v => typeof v === 'string' && v.trim()))) errors.push(`${label}: incomplete ${lang} translation`);
    }
  }
  return errors;
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const errors = reviewHelpCorpus(JSON.parse(readFileSync(process.argv[2], 'utf8')));
  console.log(JSON.stringify({ ok: !errors.length, errors, semanticReviewRequired: true }, null, 2));
  process.exitCode = errors.length ? 1 : 0;
}
