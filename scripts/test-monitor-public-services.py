import importlib.util, unittest, io, contextlib
from unittest.mock import patch
spec=importlib.util.spec_from_file_location('monitor','scripts/monitor-public-services.py');m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m)
class Response:
    status=200
    def __init__(self,body):self.body=body
    def read(self,limit):return self.body
    def __enter__(self):return self
    def __exit__(self,*args):pass
class Checks(unittest.TestCase):
    def test_contract_rejects_200_error_pages_and_invalid_health(self):
        self.assertFalse(m.validate('html',200,b'generic error'))
        self.assertFalse(m.validate('health',200,b'{"status":"error"}'))
        self.assertFalse(m.validate('health',200,b'not json'))
        self.assertFalse(m.validate('html',503,b'Padbol'))
        self.assertTrue(m.validate('health',200,b'{"status":"ok"}'))
    def test_retry_recovers_and_outage_is_failure(self):
        with patch.object(m.time,'sleep'):
            attempts=[]
            def transient(*a,**k):
                attempts.append(1)
                if len(attempts)==1:raise TimeoutError()
                return Response(b'Padbol Match')
            self.assertEqual(m.check(m.TARGETS[1],transient)['attempts'],2)
            self.assertFalse(m.check(m.TARGETS[2],lambda *a,**k:Response(b'{"status":"bad"}'))['healthy'])
    def test_alarm_test_has_nonzero_exit_without_network(self):
        with patch('sys.argv',['monitor','--test-alert']),patch.object(m,'check',side_effect=AssertionError('unexpected network')),contextlib.redirect_stdout(io.StringIO()) as output:
            self.assertEqual(m.main(),1)
            self.assertIn('::error::',output.getvalue())
if __name__=='__main__':unittest.main()
