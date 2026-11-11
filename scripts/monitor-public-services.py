#!/usr/bin/env python3
"""External availability checks: public endpoints only, no credentials or business data."""
import argparse, concurrent.futures, json, os, time, urllib.request
TARGETS = [('Web Padbol', 'https://padbol.com/', 'html'), ('Padbol Match', 'https://www.padbolmatch.com/', 'html'), ('API Padbol Match', 'https://padbol-backend.onrender.com/health', 'health')]
def validate(kind, status, body):
    if status != 200: return False
    if kind == 'health':
        try: return json.loads(body).get('status') == 'ok'
        except (ValueError, AttributeError): return False
    return 'padbol' in body.decode('utf-8', errors='replace').lower()
def check(target, opener=urllib.request.urlopen, attempts=3):
    name, url, kind = target
    started=time.monotonic()
    for attempt in range(attempts):
        try:
            request=urllib.request.Request(url, headers={'User-Agent':'Padbol-External-Monitor/1.0','Cache-Control':'no-cache'})
            with opener(request, timeout=20) as response:
                healthy=validate(kind, response.status, response.read(300000))
            if healthy:return {'service':name,'healthy':True,'attempts':attempt+1,'seconds':round(time.monotonic()-started,2)}
            reason='unexpected_response'
        except Exception as exc: reason=type(exc).__name__
        if attempt+1<attempts: time.sleep(2)
    return {'service':name,'healthy':False,'attempts':attempts,'reason':reason,'seconds':round(time.monotonic()-started,2)}
def main():
    parser=argparse.ArgumentParser();parser.add_argument('--test-alert',action='store_true');args=parser.parse_args()
    if args.test_alert:
        rows=[{'service':'SIMULACRO — alarma de disponibilidad','healthy':False,'reason':'intentional_alert_test'}]
    else:
        with concurrent.futures.ThreadPoolExecutor(max_workers=3) as executor: rows=list(executor.map(check,TARGETS))
    print(json.dumps({'checked_at_utc':time.strftime('%Y-%m-%dT%H:%M:%SZ',time.gmtime()),'services':rows},ensure_ascii=False))
    for row in rows:
        if not row['healthy']: print('::error::'+row['service']+' — '+row.get('reason','unavailable'))
    if os.environ.get('GITHUB_STEP_SUMMARY'):
        with open(os.environ['GITHUB_STEP_SUMMARY'],'a') as out:
            out.write('# Supervisión externa de Padbol\n\n'+''.join('- '+row['service']+': '+('DISPONIBLE' if row['healthy'] else 'FALLO')+'\n' for row in rows)+'\nSolo disponibilidad pública; no certifica reservas, pagos ni atención comercial.\n')
    return 0 if all(row['healthy'] for row in rows) else 1
if __name__=='__main__':raise SystemExit(main())
