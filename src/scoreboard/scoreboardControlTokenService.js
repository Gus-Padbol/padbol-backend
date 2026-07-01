import {
  generateControlToken,
  hashControlToken,
} from './scoreboardControlToken.js';

/**
 * Persiste token de control (hash only) para un scoreboard existente.
 * @returns {{ controlToken: string, controlTokenCreatedAt: string }}
 */
export async function persistControlTokenForScoreboard(supabaseAdmin, scoreboardId) {
  const controlToken = generateControlToken();
  const controlTokenCreatedAt = new Date().toISOString();

  const { error } = await supabaseAdmin
    .from('scoreboard_partidos')
    .update({
      control_token_hash: hashControlToken(controlToken),
      control_token_created_at: controlTokenCreatedAt,
      control_token_revoked_at: null,
      updated_at: controlTokenCreatedAt,
    })
    .eq('id', scoreboardId);

  if (error) throw error;

  return { controlToken, controlTokenCreatedAt };
}
