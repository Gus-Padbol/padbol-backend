function fail() { throw Object.assign(new Error('Revisa el parcial, los puntos, el saque y el motivo.'), { status: 400 }); }
export function validatePartialCorrection(body) {
 if (!body || body.confirm !== true || typeof body.reason !== 'string' || !body.reason.trim() || body.reason.trim().length > 500 || typeof body.updated_at !== 'string' || !Number.isFinite(Date.parse(body.updated_at))) fail();
 const sets = body.completed_sets;
 if (!Array.isArray(sets) || sets.length > 2) fail();
 let aWins=0,bWins=0;
 const history=sets.map((set,i)=>{
  if (!set || !Number.isInteger(set.a) || !Number.isInteger(set.b)) fail();
  const hi=Math.max(set.a,set.b), lo=Math.min(set.a,set.b);
  if (!((hi===6 && lo>=0 && lo<=4) || (hi===7 && (lo===5 || lo===6)))) fail();
  if (set.a>set.b) aWins++; else bWins++;
  return {set:i+1,a:set.a,b:set.b};
 });
 if(aWins>=2 || bWins>=2) fail();
 const {games_a:a,games_b:b,score_a:pa,score_b:pb,es_tiebreak:tb,saque_actual:serve}=body;
 if(!Number.isInteger(a)||!Number.isInteger(b)||a<0||b<0||a>6||b>6||Math.max(a,b)===6&&Math.abs(a-b)>=2||typeof tb!=='boolean'||tb!==(a===6&&b===6)||!['A','B'].includes(serve)) fail();
 if(!Number.isInteger(pa)||!Number.isInteger(pb)||pa<0||pb<0) fail();
 if(tb) {if(Math.max(pa,pb)>=7&&Math.abs(pa-pb)>=2) fail();}
 else if(![0,15,30,40,45].includes(pa)||![0,15,30,40,45].includes(pb)||(pa===45&&pb!==40)||(pb===45&&pa!==40)) fail();
 return {updatedAt:body.updated_at,reason:body.reason.trim(),state:{historial_sets:history,sets_a:aWins,sets_b:bWins,games_a:a,games_b:b,score_a:pa,score_b:pb,saque_actual:serve,es_tiebreak:tb}};
}
