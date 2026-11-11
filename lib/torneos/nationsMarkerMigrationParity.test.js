import test from 'node:test'; import assert from 'node:assert/strict'; import {readFileSync} from 'node:fs';
const deployable=readFileSync(new URL('../../supabase/migrations/20261108222114_nations_marker_durable.sql',import.meta.url),'utf8');
const candidate=readFileSync(new URL('../../sql/candidates/20261108190000_nations_marker_durable.sql',import.meta.url),'utf8');
test('migracion deployable identica al candidate y contiene terminal/casts',()=>{assert.equal(deployable,candidate);assert.match(deployable,/CREATE TABLE IF NOT EXISTS nations_marker_private\.nations_marker_terminal/);assert.match(deployable,/NEW\.id::text/);assert.match(deployable,/nations_marker_terminal_stamp/);assert.match(deployable,/FROM nations_marker_private\.nations_marker_match WHERE match_id=NEW\.id::text/);});
