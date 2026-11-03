import test from 'node:test';
import assert from 'node:assert/strict';
import { renderCrmEmailHtml } from './crmEmailTemplate.js';

test('commercial email uses the official dark-background Padbol Internacional logo', () => {
  const html = renderCrmEmailHtml({ body: 'Hola <b>equipo</b>' });
  assert.match(html, /brand\/oficial-2026\/padbol-internacional-dark\.png/);
  assert.doesNotMatch(html, /padbol-internacional-a1\.png/);
  assert.match(html, /alt="Padbol Internacional"/);
  assert.match(html, /Equipo Comercial — Padbol Internacional/);
  assert.match(html, /Plataforma tecnológica: Padbol Match/);
});

test('commercial email keeps the advisor body escaped', () => {
  const html = renderCrmEmailHtml({ body: 'Hola <b>equipo</b> & clientes' });
  assert.match(html, /Hola &lt;b&gt;equipo&lt;\/b&gt; &amp; clientes/);
  assert.doesNotMatch(html, /<b>equipo<\/b>/);
});
