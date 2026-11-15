import 'dotenv/config';
import { createClient } from '@supabase/supabase-js';
import { HUB_EDITOR_BUCKET, HUB_EDITOR_ORIGINAL_LIMIT } from '../lib/hubImageEditor.js';

// Explicit one-time action, never called during server boot or HTTP requests.
const url=process.env.SUPABASE_URL;
const key=process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SERVICE_KEY;
if(!url || !key)throw Error('Server Storage credentials required; no changes made.');
const client=createClient(url,key,{auth:{persistSession:false,autoRefreshToken:false}});
let {data,error}=await client.storage.getBucket(HUB_EDITOR_BUCKET);
if(error && !['404','400'].includes(String(error.statusCode)))throw Error('Could not verify private bucket; no changes made.');
if(!data){
  if(!process.argv.includes('--apply')) {
    console.log(JSON.stringify({ready:false,bucket:HUB_EDITOR_BUCKET,reason:'missing_private_bucket',changesMade:false,applyFlagRequired:true}));
    process.exit(2);
  }
  const result=await client.storage.createBucket(HUB_EDITOR_BUCKET,{public:false,fileSizeLimit:HUB_EDITOR_ORIGINAL_LIMIT,allowedMimeTypes:['image/jpeg','image/png','image/webp','application/json']});
  if(result.error)throw Error('Private bucket creation failed.');
}
({data,error}=await client.storage.getBucket(HUB_EDITOR_BUCKET));
if(error || !data || data.public!==false)throw Error('Private Storage readiness failed; existing bucket was not changed.');
console.log(JSON.stringify({ready:true,bucket:HUB_EDITOR_BUCKET,public:false,policiesChanged:false,rolesChanged:false}));
