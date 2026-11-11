import test from 'node:test';import assert from 'node:assert/strict';
import {createCommercialImapSenderReader} from './crmCommercialImapScope.js';
test('commercial IMAP scope queries authoritative eligible cases and accepts only same-contact original alias',async()=>{
 let sql;const reader=createCommercialImapSenderReader({pool:{async query(q){sql=q;return {rows:[{email_normalized:'firstlast@gmail.com',identity_used:'First.Last+project@gmail.com'}, {email_normalized:'other@example.test',identity_used:'attacker@example.test'}, {email_normalized:'bad email',identity_used:'arbitrary@example.test'}]};}}});
 assert.deepEqual(await reader(),['firstlast@gmail.com','first.last+project@gmail.com','other@example.test']);
 assert.match(sql,/crm_commercial_form_is_allowed\(c.id\)/);assert.match(sql,/crm_inbound_events/);assert.doesNotMatch(sql,/qualification_data/);
});
test('commercial scope fails closed on missing storage and excessive results',async()=>{
 await assert.rejects(createCommercialImapSenderReader()());
 await assert.rejects(createCommercialImapSenderReader({pool:{query:async()=>({rows:Array(1001).fill({})})}})());
 assert.deepEqual(await createCommercialImapSenderReader({pool:{query:async()=>({rows:[]})}})(),[]);
});
