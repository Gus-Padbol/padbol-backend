import {createHash} from 'node:crypto';
const keys=new Set(['classes','tournaments','leagues','buffet','merchandising','events','sponsorships','memberships','other']);
const number=(v,max=1e9)=>typeof v==='number'&&Number.isFinite(v)&&v>=0&&v<=max?v:null;
const text=(v,max=160)=>String(v??'').replace(/[<>\r\n]/g,' ').trim().slice(0,max);
const minutes=v=>/^([01]\d|2[0-3]):[0-5]\d$/.test(String(v))?Number(v.slice(0,2))*60+Number(v.slice(3)):v==='24:00'?1440:null;
export function createSimulationSnapshot(source,{now=()=>new Date().toISOString()}={}){
 if(source?.type!=='business-v2'||source.complementaryMode!=='monthly')return null;
 const courts=number(source.courts,20),days=number(source.openDays,31),budget=number(source.budget),reference=number(source.referencePerCourt,1e6);
 if(!courts||!Number.isInteger(courts)||!days||!Number.isInteger(days)||budget===null||reference===null)return null;
 if(!Array.isArray(source.activities)||source.activities.length>30||!Array.isArray(source.simpleMonthlyRevenues)||source.simpleMonthlyRevenues.length>9||!Array.isArray(source.complements)||source.complements.length>12)return null;
 const activities=[];
 for(const row of source.activities){
  if(!row||typeof row!=='object')return null;
  const start=minutes(row.start),end=minutes(row.end),hours=row.hours===undefined&&start!==null&&end!==null?(end-start)/60:number(row.hours,6),rate=number(row.rate,1e7),rowDays=number(row.days,31);
  if(!['morning','afternoon','evening','noon'].includes(row.period)||start===null||end===null||end<=start||!hours||Math.abs(hours-(end-start)/60)>1/60||rate===null||rowDays===null||!Number.isInteger(rowDays))return null;
  activities.push({period:row.period,label:text(row.label,60),start:row.start,end:row.end,hours,days:rowDays,rate});
 }
 const sorted=[...activities].sort((a,b)=>minutes(a.start)-minutes(b.start));
 if(sorted.some((row,i)=>i&&minutes(row.start)<minutes(sorted[i-1].end)))return null;
 const revenues=[],seen=new Set();
 for(const row of source.simpleMonthlyRevenues){
  if(!row||!keys.has(row.key)||seen.has(row.key)||number(row.amount)===null)return null;seen.add(row.key);
  const entry={key:row.key,label:text(row.label,80)||row.key,amount:row.amount};
  if(row.inputs!==undefined){const size=row.key==='leagues'?2:['classes','tournaments','buffet'].includes(row.key)?3:0;if(!size||!Array.isArray(row.inputs)||row.inputs.length!==size||row.inputs.some(v=>number(v,1e6)===null)||Math.abs(row.inputs.reduce((a,b)=>a*b,1)-row.amount)>.01)return null;entry.inputs=[...row.inputs];entry.example=row.example===true;}
  revenues.push(entry);
 }
 const complements=[];
 for(const row of source.complements){if(!row||!text(row.key,40)||(row.budget!=null&&number(row.budget)===null))return null;complements.push({key:text(row.key,40),label:text(row.label,160),budget:row.budget??null,pending:row.pending===true||row.budget==null});}
 const costs=source.monthlyOperatingCosts==null?null:number(source.monthlyOperatingCosts);if(source.monthlyOperatingCosts!=null&&costs===null)return null;
 const hours=activities.reduce((a,r)=>a+r.hours,0),courtRevenue=activities.reduce((a,r)=>a+r.hours*r.days*r.rate*courts,0),otherRevenue=revenues.reduce((a,r)=>a+r.amount,0),totalRevenue=courtRevenue+otherRevenue;
 const investment=Math.max(budget,courts*reference+complements.reduce((a,r)=>a+(r.budget??0),0)),operatingResult=costs===null?null:totalRevenue-costs;
 let recoveryMonths=investment>0&&operatingResult>0?investment/operatingResult:null;
 if(source.advertisingMaintenanceEnabled===true&&costs!==null&&investment>0){const first=totalRevenue-costs+250;recoveryMonths=first>0&&investment<=first*3?investment/first:operatingResult>0?3+(investment-first*3)/operatingResult:null;}
 const rate=hours>0?courtRevenue/(courts*days*hours):null;
 const snapshot={version:1,currency:['USD','EUR','ARS','MXN','CLP'].includes(source.currency)?source.currency:'USD',budget,courts,days,referencePerCourt:reference,existingFacilities:source.existingFacilities===true,activities,revenues,complements,costsSource:['example','entered'].includes(source.operatingCostsSource)?source.operatingCostsSource:costs===null?'unknown':'entered',advertisingMaintenanceEnabled:source.advertisingMaintenanceEnabled===true,financials:{investment,courtRevenue,otherRevenue,totalRevenue,monthlyOperatingCosts:costs,operatingResult,recoveryMonths,bookingHoursPerCourtDay:hours,breakEvenHours:costs!==null&&rate>0?Math.max(0,costs-otherRevenue)/(courts*days*rate):null},pendingInvestment:complements.some(r=>r.pending)};
 return {...snapshot,fingerprint:createHash('sha256').update(JSON.stringify(snapshot)).digest('hex'),savedAt:now()};
}
