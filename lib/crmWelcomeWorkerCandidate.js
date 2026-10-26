import {processSerializedWelcomeCandidate} from './crmWelcomeSerializedCandidate.js';
// Nothing starts on import. A trusted bootstrap must verify exact approved
// templates, Chivi readiness and config before setting enabled=true.
export function createWelcomeWorkerCandidate({enabled=false,repository,lockStore,transport,templates,logger=console,batchSize=20}={}) {
 let running=false;
 return {async tick() {
  if(enabled!==true)return {status:'disabled'};
  if(running)return {status:'busy'};
  running=true;let attempted=0;
  try {
   const ids=await repository.listPending(batchSize);
   for(const sourceId of ids){
    try{await processSerializedWelcomeCandidate({sourceId,enabled:true,templates,repository,lockStore,transport});attempted++}
    catch{logger?.warn?.('[welcome-worker] processing failed; reconciliation required');}
   }
   return {status:'complete',attempted};
  } finally {running=false}
 }};
}

// Explicit bootstrap, never called merely by importing this module. A crash
// before claim is recovered by the next scan. A crash after claim is held for
// manual reconciliation, not replayed automatically.
export function startWelcomeWorkerCandidate(options={}) {
 if(options.enabled!==true)return {started:false,stop(){}};
 const ms=options.intervalMs;
 if(!Number.isInteger(ms)||ms<5000||ms>300000)throw Error('WELCOME_INTERVAL_INVALID');
 const worker=createWelcomeWorkerCandidate(options);
 const safeTick=()=>worker.tick().catch(()=>options.logger?.warn?.('[welcome-worker] scan failed'));
 const timer=setInterval(safeTick,ms);timer.unref?.();safeTick();
 return {started:true,stop(){clearInterval(timer)}};
}
