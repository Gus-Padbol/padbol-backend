import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { AI_ALLOWED_SKILLS } from '../src/ai/constants.js';
import { validateAiChatRequest } from '../src/ai/context/allowlist.js';
import {
  MATCH_SUMMARY_PROMPT_VERSION,
  MATCH_SUMMARY_SYSTEM_PROMPT,
} from '../src/ai/prompts/matchSummaryV1.js';
import {
  formatPromptVersion,
  resolvePromptForSkill,
} from '../src/ai/prompts/registry.js';

describe('matchSummaryPrompt', () => {
  it('registry resuelve match-summary', () => {
    const prompt = resolvePromptForSkill('match-summary');

    assert.equal(prompt.id, 'match-summary');
    assert.equal(prompt.version, '1.5.0');
    assert.equal(prompt.system, MATCH_SUMMARY_SYSTEM_PROMPT);
    assert.equal(formatPromptVersion(prompt), 'match-summary@1.5.0');
    assert.equal(MATCH_SUMMARY_PROMPT_VERSION, 'match-summary@1.5.0');
  });

  it('prompt exige mínimo 2 frases y parciales obligatorios con sets', () => {
    assert.match(MATCH_SUMMARY_SYSTEM_PROMPT, /MÍNIMO 2 frases/i);
    assert.match(MATCH_SUMMARY_SYSTEM_PROMPT, /MÁXIMO 4 frases/i);
    assert.match(MATCH_SUMMARY_SYSTEM_PROMPT, /parciales de sets/i);
    assert.match(MATCH_SUMMARY_SYSTEM_PROMPT, /tercer set decisivo/i);
    assert.match(MATCH_SUMMARY_SYSTEM_PROMPT, /Parciales:/i);
  });

  it('prompt pide variedad de redacción', () => {
    assert.match(MATCH_SUMMARY_SYSTEM_PROMPT, /VARIEDAD DE REDACCIÓN/i);
    assert.match(MATCH_SUMMARY_SYSTEM_PROMPT, /partido ajustado/i);
    assert.match(MATCH_SUMMARY_SYSTEM_PROMPT, /plantilla_fallback/i);
    assert.match(MATCH_SUMMARY_SYSTEM_PROMPT, /Emails, usernames técnicos/i);
  });

  it('prompt incluye regla no inventar', () => {
    assert.match(MATCH_SUMMARY_SYSTEM_PROMPT, /no inventar/i);
    assert.match(MATCH_SUMMARY_SYSTEM_PROMPT, /SOLO datos presentes/i);
  });

  it('prompt exige JSON válido de salida', () => {
    assert.match(MATCH_SUMMARY_SYSTEM_PROMPT, /JSON válido/i);
    assert.match(MATCH_SUMMARY_SYSTEM_PROMPT, /title/i);
    assert.match(MATCH_SUMMARY_SYSTEM_PROMPT, /summary/i);
    assert.match(MATCH_SUMMARY_SYSTEM_PROMPT, /highlights/i);
    assert.match(MATCH_SUMMARY_SYSTEM_PROMPT, /disclaimers/i);
    assert.match(MATCH_SUMMARY_SYSTEM_PROMPT, /source_fields_used/i);
    assert.match(MATCH_SUMMARY_SYSTEM_PROMPT, /PROHIBIDO.*markdown/is);
  });

  it('prompt prohíbe usernames técnicos y lenguaje administrativo en summary', () => {
    assert.match(MATCH_SUMMARY_SYSTEM_PROMPT, /usernames técnicos/i);
    assert.match(MATCH_SUMMARY_SYSTEM_PROMPT, /equipo formado por/i);
    assert.match(MATCH_SUMMARY_SYSTEM_PROMPT, /confirmado por capitanes/i);
    assert.match(MATCH_SUMMARY_SYSTEM_PROMPT, /disclaimers administrativos van SOLO en disclaimers/i);
    assert.match(MATCH_SUMMARY_SYSTEM_PROMPT, /Equipo 1 se impuso a Equipo 2 por 2 sets a 1/i);
  });

  it('prompt prohíbe MVP si no está en payload', () => {
    assert.match(MATCH_SUMMARY_SYSTEM_PROMPT, /No mencionar MVP/i);
    assert.match(MATCH_SUMMARY_SYSTEM_PROMPT, /salvo que exista explícitamente en el payload/i);
  });

  it('prompt menciona scoreboard_opcional', () => {
    assert.match(MATCH_SUMMARY_SYSTEM_PROMPT, /scoreboard_opcional/i);
    assert.match(MATCH_SUMMARY_SYSTEM_PROMPT, /historial_sets/i);
    assert.match(MATCH_SUMMARY_SYSTEM_PROMPT, /equipo_a_nombre/i);
    assert.match(MATCH_SUMMARY_SYSTEM_PROMPT, /equipo_b_jugadores/i);
    assert.match(MATCH_SUMMARY_SYSTEM_PROMPT, /SCOREBOARD_OPCIONAL/i);
  });

  it('prompt permite duración solo si existe', () => {
    assert.match(MATCH_SUMMARY_SYSTEM_PROMPT, /duracion_minutos/i);
    assert.match(
      MATCH_SUMMARY_SYSTEM_PROMPT,
      /duracion_minutos > 0/is,
    );
    assert.match(
      MATCH_SUMMARY_SYSTEM_PROMPT,
      /cronometro_segundos es 0, null/i,
    );
  });

  it('prompt prohíbe remontadas sin campo explícito', () => {
    assert.match(MATCH_SUMMARY_SYSTEM_PROMPT, /No inferir remontadas/i);
    assert.match(
      MATCH_SUMMARY_SYSTEM_PROMPT,
      /NO inferir remontadas a partir de historial_sets/i,
    );
  });

  it('prompt prioriza resultado confirmado si hay contradicción', () => {
    assert.match(MATCH_SUMMARY_SYSTEM_PROMPT, /PRIORIZÁ resultado confirmado/i);
    assert.match(
      MATCH_SUMMARY_SYSTEM_PROMPT,
      /contradice scoreboard_opcional/i,
    );
    assert.match(
      MATCH_SUMMARY_SYSTEM_PROMPT,
      /posible diferencia entre fuentes/i,
    );
  });

  it('prompt prohíbe punto clave, racha y rally sin campo explícito', () => {
    assert.match(
      MATCH_SUMMARY_SYSTEM_PROMPT,
      /"punto clave", "MVP", "racha" ni "rally"/i,
    );
  });

  it('skill match-summary está permitida', () => {
    assert.ok(AI_ALLOWED_SKILLS.has('match-summary'));

    const parsed = validateAiChatRequest({
      skill: 'match-summary',
      message: 'Generar resumen',
    });

    assert.equal(parsed.skill, 'match-summary');
  });
});
