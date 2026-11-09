import { fetchNationsApprovalMap } from '../lib/torneos/nationsApprovalMap.js';
import { loadNationsCountryRanking } from '../lib/torneos/nationsCountryRankingService.js';
import { isNationsPublicRevealed } from '../lib/torneos/nationsPublicAccess.js';

function fail(res, failure) {
  const status = Number(failure?.status ?? 503);
  return res.status(status).json({
    ok: false,
    code: failure?.code ?? 'NATIONS_COUNTRY_RANKING_UNAVAILABLE',
    error: failure?.status
      ? failure.message
      : 'No se pudo comprobar el ranking de países. Actualiza y reintenta.',
  });
}

/**
 * Public accumulated country ranking. It is intentionally mounted outside the
 * player ranking contract so the individual `/api/rankings` response and its
 * historical FIPA rows stay untouched.
 */
export function mountNationsCountryRankingRoutes(app, { db }) {
  app.get('/api/nations/country-ranking', async (req, res) => {
    try {
      const approvals = await fetchNationsApprovalMap(db, []);
      const items = await loadNationsCountryRanking(db, {
        isRevealed: (torneo, now) => isNationsPublicRevealed(
          torneo,
          now,
          approvals.get(Number(torneo.id)) === true,
        ),
      });
      return res.json({ ok: true, items });
    } catch (failure) {
      return fail(res, failure);
    }
  });
}
