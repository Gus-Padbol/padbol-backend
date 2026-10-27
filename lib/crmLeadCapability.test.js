import test from 'node:test';
import assert from 'node:assert/strict';
import { createCrmAdminService } from './crmAdmin.js';

test('lead analysis capability is a boolean based only on the actual configured callback and confers no operator rights', () => {
 for (const leadAnalyzer of [null, undefined, 'credential-marker', async () => {}]) {
  const service = createCrmAdminService({ repository: {}, leadAnalyzer, resolvePermissions: () => ({ role: 'super_admin', canOperate: false, canAudit: true }) });
  const result = service.getPermissions({ email: 'audit@example.com', role: 'super_admin' });
  assert.equal(result.leadAnalysisEnabled, typeof leadAnalyzer === 'function');
  assert.equal(result.canOperate, false); assert.equal(result.canAudit, true);
  assert.ok(!JSON.stringify(result).includes('credential-marker'));
 }
});
