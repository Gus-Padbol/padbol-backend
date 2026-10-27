#!/usr/bin/env python3
"""Prepare a QA-only principal/token privately; does not contact a database or server."""
import argparse,hashlib,json,os,pathlib,secrets,uuid

def main():
    p=argparse.ArgumentParser();p.add_argument('--runtime-dir',type=pathlib.Path,default=pathlib.Path.home()/'Library/Application Support/PadbolSoporte');p.add_argument('--enabled-for-qa',action='store_true');a=p.parse_args()
    root=a.runtime_dir.expanduser().absolute()
    if any(x.is_symlink() for x in (root,*root.parents)):raise SystemExit('PRIVATE_PATH_INVALID')
    root.mkdir(parents=True,exist_ok=True,mode=0o700);os.chmod(root,0o700)
    credential=root/'executor-qa-credential.json';sql=root/'provision-qa.sql'
    if credential.exists() or sql.exists():raise SystemExit('PRIVATE_PROVISION_ALREADY_EXISTS')
    token=secrets.token_urlsafe(48);principal=str(uuid.uuid4());hash_=hashlib.sha256(token.encode()).hexdigest()
    files=[(credential,json.dumps({'principalId':principal,'baseUrl':'https://padbol-backend-qa.onrender.com/api/internal/support-executor','token':token,'scope':'mini_prepare','environment':'qa'},indent=2)),(sql,"-- QA only. Token is never stored in SQL. No sender/coordination permission.\nINSERT INTO public.crm_support_executor_principals(id,label,token_sha256,capability,enabled) VALUES ('"+principal+"','Mac mini QA prepare','"+hash_+"','mini_prepare',"+('true' if a.enabled_for_qa else 'false')+");\n")]
    for path,text in files:
        fd=os.open(path,os.O_WRONLY|os.O_CREAT|os.O_EXCL|getattr(os,'O_NOFOLLOW',0),0o600)
        with os.fdopen(fd,'w',encoding='utf-8') as f:f.write(text)
    print(json.dumps({'state':'private_qa_provisioning_prepared','credentialPath':str(credential),'sqlPath':str(sql),'databaseChanged':False}))
if __name__=='__main__':main()
