import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { mountAdminHelpRoutes, readAdminHelpRole } from './adminHelp.js';
import { ADMIN_HELP_ARTICLES } from '../lib/adminHelpArticles.js';

async function fixture(t, { role = 'super_admin', auth, fetchRole, articles } = {}) {
  const app = express();
  mountAdminHelpRoutes(app, {
    getAuthenticatedUser: auth || (async req => req.headers.authorization === 'Bearer fixture' ? { user: { id: 'synthetic', user_metadata: { role: 'super_admin' } } } : { user: null }),
    fetchUserRoleRowForAuthUser: fetchRole || (async () => ({ role, sede_id: 7 })),
    ...(articles ? { articles } : {}),
  });
  const server = app.listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  t.after(() => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }));
  return async (path, token = true) => {
    const response = await fetch(`http://127.0.0.1:${server.address().port}/api/admin/help/${path}`, { headers: token ? { authorization: 'Bearer fixture', 'x-role': 'super_admin' } : {} });
    assert.equal(response.headers.get('cache-control'), 'private, no-store');
    assert.match(response.headers.get('vary'), /Authorization/);
    return { status: response.status, body: await response.json() };
  };
}
for (const role of ['admin_club', 'admin_cadena', 'admin_nacional', 'super_admin']) {
  test(`real HTTP: ${role} only receives authorized summaries and details`, async t => {
    const get = await fixture(t, { role });
    const list = await get('search');
    assert.equal(list.status, 200);
    assert.equal(list.body.total, role === 'super_admin' ? 2 : 1);
    const support = await get('articles/soporte/gestionar-tickets');
    assert.equal(support.status, role === 'super_admin' ? 200 : 403);
    const search = await get('search?q=tickets&role=super_admin');
    assert.equal(search.body.total, role === 'super_admin' ? 1 : 0);
    if (role !== 'super_admin') assert.doesNotMatch(JSON.stringify(list), /tickets|gestionar-tickets/);
    const panel = await get('articles/administracion/panel-por-rol');
    assert.equal(panel.status, 200);
    assert.ok(panel.body.article.steps.length);
    assert.equal(panel.body.article.url, '/ayuda/administracion/administracion/panel-por-rol');
    for (const item of list.body.results) assert.equal(item.url, `/ayuda/administracion/${item.module}/${item.slug}`);
    assert.equal(panel.body.article.verification, 'source-reviewed');
    assert.equal((await get('articles/unknown/unknown')).status, 403);
    assert.equal((await get('articles/administracion/unknown')).status, 403);
  });
}
for (const role of ['jugador', 'player', 'empleado', 'editor_contenido', '', null]) {
  test(`deny persisted ${role}, despite forged claims, query and headers`, async t => {
    const get = await fixture(t, { role });
    for (const path of ['search?role=super_admin', 'articles/soporte/gestionar-tickets']) {
      const result = await get(path);
      assert.equal(result.status, 403);
      assert.deepEqual(result.body, { error: 'HELP_FORBIDDEN', code: 'HELP_FORBIDDEN' });
    }
  });
}
test('anonymous denied and dependency failures closed without diagnostic leakage', async t => {
  const get = await fixture(t);
  assert.equal((await get('search', false)).status, 401);
  for (const deps of [{ auth: async () => { throw Error('private-token'); } }, { fetchRole: async () => { throw Error('private-db'); } }]) {
    const broken = await fixture(t, deps);
    const result = await broken('search');
    assert.equal(result.status, 503);
    assert.doesNotMatch(JSON.stringify(result), /private-token|private-db/);
  }
});
test('ES/EN search, accent folding, PT absence fails without fallback; invalid query rejected', async t => {
  const get = await fixture(t);
  assert.equal((await get('search?q=sesi%C3%B3n&lang=es')).body.total, 2);
  assert.equal((await get('search?q=session&lang=en')).body.total, 2);
  assert.equal((await get('search?lang=pt')).status, 409);
  assert.equal((await get('articles/soporte/gestionar-tickets?lang=pt')).status, 409);
  for (const query of ['lang=fr', 'lang[]=es', 'q[]=x', `q=${'x'.repeat(121)}`]) assert.equal((await get(`search?${query}`)).status, 400);
  const pt = ADMIN_HELP_ARTICLES.map(a => ({ ...a, translations: { ...a.translations, pt: { title: 'Painel', requirements: ['Sessão válida'], steps: ['Abra o painel'], limit: 'Exemplo sintético' } } }));
  const translated = await fixture(t, { articles: pt });
  assert.equal((await translated('search?lang=pt&q=sessao')).body.total, 2);
});
test('revocation, changed scope, lost session, and second-read failure discard computed content', async t => {
  for (const next of [null, { role: 'jugador' }, { role: 'super_admin', sede_id: 8 }]) {
    let calls = 0;
    const get = await fixture(t, { fetchRole: async () => ++calls === 1 ? { role: 'super_admin', sede_id: 7 } : next });
    const result = await get('search');
    assert.equal(result.status, 403);
    assert.doesNotMatch(JSON.stringify(result), /tickets|panel-por-rol/);
  }
  let authCalls = 0;
  const lost = await fixture(t, { auth: async () => ++authCalls === 1 ? { user: { id: 'synthetic' } } : { user: null } });
  assert.equal((await lost('articles/soporte/gestionar-tickets')).status, 401);
  let calls = 0;
  const broken = await fixture(t, { fetchRole: async () => { if (++calls === 2) throw Error('private'); return { role: 'super_admin' }; } });
  assert.equal((await broken('search')).status, 503);
});
test('filtering happens before reading protected content and ignores drafts', async t => {
  const hidden = { module: 'secret', slug: 'secret', status: 'reviewed', allowedRoles: ['super_admin'], get translations() { throw Error('Protected corpus accessed'); } };
  const draft = { ...ADMIN_HELP_ARTICLES[0], id: 'draft', status: 'pending' };
  const get = await fixture(t, { role: 'admin_club', articles: [...ADMIN_HELP_ARTICLES, hidden, draft] });
  assert.equal((await get('search')).body.total, 1);
  assert.equal((await get('articles/secret/secret')).status, 403);
});

test('persisted role lookup is read-only, UUID-bound, no email claim or fallback', async () => {
  const calls = [];
  const query = { select: columns => { calls.push(['select', columns]); return query; }, eq: (key, value) => { calls.push(['eq', key, value]); return query; }, maybeSingle: async () => ({ data: null, error: null }) };
  const db = { from: table => { calls.push(['from', table]); return query; } };
  assert.equal(await readAdminHelpRole(db, { id: 'verified-user', email: 'pending@example.test', email_confirmed_at: 'now' }), null);
  assert.deepEqual(calls.filter(x => x[0] === 'eq'), [['eq', 'user_id', 'verified-user']]);
  assert.equal(calls.filter(x => x[0] === 'from').length, 1);
  assert.equal(await readAdminHelpRole(db, null), null);
});
test('club without persisted venue cannot read module guidance', async t => {
  for (const sede_id of [null, '', 0, -1, 'invalid']) {
    const get = await fixture(t, { fetchRole: async () => ({ role: 'admin_club', sede_id }) });
    assert.equal((await get('search')).status, 403);
  }
});

test('denied and nonexistent details within a shared module are indistinguishable', async t => {
  const secret = { ...ADMIN_HELP_ARTICLES[1], module: 'administracion', slug: 'private' };
  const get = await fixture(t, { role: 'admin_club', articles: [...ADMIN_HELP_ARTICLES, secret] });
  assert.deepEqual(await get('articles/administracion/private'), await get('articles/administracion/nonexistent'));
});
