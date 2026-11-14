import test from 'node:test';import assert from 'node:assert/strict';
import {evaluateTorneoAdminScope} from './torneoAdminScopes.js';
const base={userId:'u1',torneoId:57,canchaId:1,scope:{torneo_id:57,cancha_ids:[1,2,3],revoked_at:null}};
test('scope exacto permite torneo y cancha',()=>assert.equal(evaluateTorneoAdminScope(base).allowed,true));
test('otro torneo/cancha se rechaza',()=>{assert.equal(evaluateTorneoAdminScope({...base,torneoId:58}).allowed,false);assert.equal(evaluateTorneoAdminScope({...base,canchaId:4}).allowed,false);});
test('revocado y sin scope se rechazan',()=>{assert.equal(evaluateTorneoAdminScope({...base,scope:{...base.scope,revoked_at:'2026-01-01'}}).reason,'NO_SCOPE');assert.equal(evaluateTorneoAdminScope({...base,scope:null}).allowed,false);});
test('super admin conserva acceso; no crea scope',()=>assert.equal(evaluateTorneoAdminScope({...base,role:{role:'super_admin'},scope:null}).allowed,true));
