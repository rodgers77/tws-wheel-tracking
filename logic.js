// TWS wheel tracking rules. Shared by the phone app (local mode) and the Cloudflare Worker (shared mode),
// so the strict order and the acid 8 / oven 6 limits are enforced the same way in both places.
(function(){
const ACID_MAX = 8, OVEN_MAX = 6;
const SCHEMA='tws-eight-20261108-1';
// Ian: Acid is ONE scan (in acid until scanned at Prep). Finish is the eighth/final step.
// Lacquer is one signed tick; only completing Finish alerts the Office.
// Office Hold/Release is a job-list button, not a station.
const S = [
 {id:'rec',name:'1 Booking'},
 {id:'wm',name:'2 Wheel machine',checks:[]},
 {id:'acid',name:'3 Acid room',checks:['No inserts — double-check the previous operator has removed them','No weights and valves']},
 {id:'prep',name:'4 Prep',checks:['All residue removed','Hub taped','Imperfections sanded']},
 {id:'oven',name:'5 Oven',batch:true},
 {id:'cut',name:'6 Diamond cut',checks:['Cut done']},
 {id:'lac',name:'7 Lacquer',checks:['Lacquer done']},
 {id:'fin',name:'8 Finish',checks:['Tyres on','Balanced'],nums:['Front PSI','Rear PSI','Torque'],pressure:true}];
// Diamond cut wheels go back in the oven after cutting (lacquer bake), as before.
const route = j => ['wm','acid','prep','oven', ...(j.finish=='Diamond cut'?['cut','oven']:[]),'lac','fin'];
const step = j => route(j)[j.pos];
// Display only: keep the original stored wheel-size/legacy tyre descriptor unchanged.
const wheelSize = value => {const text=String(value??'').trim();return /^\d+(?:\.\d+)?$/.test(text)?text+' inch':text;};
const sum = b => b.reduce((a,j)=>a+ +j.n,0);
// Wheels in acid = scanned into acid, not yet taken at Prep.
const wheels = (DB,id) => sum(DB.jobs.filter(j=>!j.done&&step(j)==id));
// Manual number first (lowest first), then Rush, then original booking FIFO. Equal times use the stable part code as a tie-break.
const order = (a,b) => String(a)<String(b)?-1:String(a)>String(b)?1:0;
const rank = j => Number.isSafeInteger(j.priorityNumber)&&j.priorityNumber>0?j.priorityNumber:Infinity;
const compare = (a,b) => (rank(a)===rank(b)?0:rank(a)<rank(b)?-1:1) || Number(b.rush===true)-Number(a.rush===true) ||
  order(a.booked,b.booked) || order(a.part,b.part);
// Keep this phone's already-open work ahead of newly rushed work. Other phones cannot take its claim.
const due = (DB,id,dev) => DB.jobs.filter(j=>!j.done&&!j.hold&&step(j)==id&&!j.inBatch&&!(j.claim&&j.claim.dev!=dev))
  .sort((a,b)=>Number(!!b.claim)-Number(!!a.claim) || compare(a,b))[0];
const st = id => S.find(s=>s.id==id);
// One checklist schema for the phone and Worker. Tyre included is NOT physical tyre presence.
const jobHasTyre = j => j.jobType!=='Loose wheel'||j.hasTyre==='Yes';
const requirements = (j,id) => {
 const base=st(id)||{};
 if(id==='wm')return {...base,nameRequired:true,checks:[...(base.checks||[]),...(jobHasTyre(j)?['Tyres removed','Valve removed','Weights removed','Wheel checked for buckles and cracks','Inserts removed','TPMS, centre cap and inserts stored in tyre']:[])]};
 if(id!='fin')return base;
 if(j.jobType!=='Loose wheel')return base; // legacy jobs are Car
 if(jobHasTyre(j))return {...base,checks:['Tyres on','Balanced','Hub sanded'],nums:['Front PSI','Rear PSI','Torque'],pressure:true};
 if(j.hasTyre==='No')return {...base,checks:['Hub sanded'],nums:[],pressure:false,nameRequired:true};
 return {...base,checks:[],nums:[],pressure:false,blocked:'Confirm whether this loose wheel has a tyre before Finish.'};
};
const str = (v,n=80) => String(v??'').replace(/[\r\n\t]+/g,' ').trim().slice(0,n);
// Apply one action to the state. Returns {ok, msg, open?}. Mutates DB.
// Every log line is also returned in r.events (full detail) so the Worker can append it to the D1 events table.
function apply(DB, a, t){ const ev=[]; const r=apply1(DB,a,t,ev); if(r&&!r.ignored)r.events=ev; return r; }
function apply1(DB, a, t, ev){
 t = t || new Date().toISOString(); const dev = str(a.dev,40);
 const log = (job,station,what,name='',x={})=>{DB.log.push({t,job,station,what,name});const j=DB.jobs.find(y=>y.part==job);
  ev.push({t,part:job,jobno:j?j.job:'',cust:j?j.cust:'',station,action:x.action||what,items:x.items||'',nums:x.nums||'',name,dev,detail:what});if(DB.log.length>3000)DB.log.splice(0,DB.log.length-3000);};
 const alertOffice = m=>{DB.alerts.push({t,msg:m});if(DB.alerts.length>500)DB.alerts.shift();log('',str(a.st),'ALERT: '+m,'',{action:/^Job complete/.test(m)?'complete':'alert'});};
 const advance = j=>{j.claim=null;j.pos++;if(j.pos>=route(j).length){j.done=1;alertOffice(`Job complete: ${j.part} (${j.cust}, job ${j.job})`);}};
 const s = st(a.st);
 switch(a.type){
 case 'book': { const j={}; for(const k of ['part','job','cust','tyre','make','reg','staying','tyreinc'])j[k]=str(a.job&&a.job[k]);
  // Match the existing Yes / No / unselected reception controls; missing is not Yes.
  for(const k of ['centrecaps','inserts'])j[k]=['Yes','No'].includes(a.job&&a.job[k])?a.job[k]:'';
  j.jobType=(a.job&&a.job.jobType)||'Car';
  if(!['Car','Loose wheel'].includes(j.jobType))return {ok:false,msg:'Choose Car or Loose wheel.'};
  j.hasTyre=['Yes','No'].includes(a.job&&a.job.hasTyre)?a.job.hasTyre:'';
  if(j.jobType==='Loose wheel'&&(!j.hasTyre||Number(a.job&&a.job.n)!==1))return {ok:false,msg:'Loose wheel needs exactly 1 wheel and With tyre / Without tyre selected.'};
  j.n=Math.max(1,Math.min(4,parseInt(a.job&&a.job.n)||0)); j.finish=(a.job&&a.job.finish)=='Diamond cut'?'Diamond cut':'Powder coat';
  if(!j.part||!j.cust)return {ok:false,msg:'Part number and customer needed.'};
  if(DB.jobs.some(x=>x.part==j.part&&!x.done))return {ok:false,msg:'Part number already in workshop - mark triangle/square variant.'};
  Object.assign(j,{booked:t,pos:0,ticks:[]});DB.jobs.push(j);log(j.part,'rec','booked in','',{action:'book'});return {ok:true,msg:'Booked in '+j.part}; }
 case 'scan': { if(!s||!route({}).concat('cut').includes(s.id))return {ok:false,msg:'Not a scanning station.'};
  const code=str(a.code); if(!code)return {ok:false,ignored:true}; // empty scan: no alert, no log
  const d=due(DB,s.id,dev);
  if(!d||d.part!=code){alertOffice(`Wrong scan at ${s.name}: ${code}${d?' (expected '+d.part+')':''}`);
   return {ok:false,msg:`REJECTED: ${code} is not the next wheel due here${d?' (next is '+d.part+')':''}. Office notified.`};}
  if(s.id=='acid'&&wheels(DB,'prep')+ +d.n>ACID_MAX)return {ok:false,msg:`Acid full: max ${ACID_MAX} wheels.`};
  if(s.batch){if(sum(DB.jobs.filter(j=>j.inBatch))+ +d.n>OVEN_MAX)return {ok:false,msg:`Oven batch full: max ${OVEN_MAX} wheels.`};
   d.inBatch=1;log(d.part,'oven','added to batch','',{action:'scan'});return {ok:true,msg:d.part+' added to batch'};}
  const req=requirements(d,s.id);
  log(d.part,s.id,'scanned','',{action:'scan'});
  if(!(req.checks||[]).length&&!(req.nums||[]).length&&!req.nameRequired){advance(d);return {ok:true,msg:d.part+' booked in at wheel machine'};}
  d.claim={st:s.id,dev};return {ok:true,open:d.part}; }
 case 'tick': { const j=DB.jobs.find(x=>x.part==a.part&&!x.done), who=str(a.who,60);
  if(!s||!j||step(j)!=s.id||!j.claim||j.claim.dev!=dev)return {ok:false,msg:'That wheel is not open on this phone any more - scan again.'};
  const req=requirements(j,s.id);if(req.blocked)return {ok:false,msg:req.blocked,open:j.part};
  if(!(req.checks||[]).every((c,i)=>a.checks&&a.checks[i]))return {ok:false,msg:'Tick every item first.',open:j.part};
  if(!who)return {ok:false,msg:'Enter your name.',open:j.part};
  const supplied = (req.nums||[]).map((n,i)=>String(a.nums?.[i]??'').trim());
  if(s.id==='fin'){
   const positive=v=>/^[+]?(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?$/i.test(v)&&Number.isFinite(Number(v))&&Number(v)>0;
   if(supplied.some(v=>v&&!positive(v)))return {ok:false,msg:'Every entered pressure and torque must be a finite number greater than zero.',open:j.part};
   if(req.pressure&&!supplied[0]&&!supplied[1])return {ok:false,msg:'Enter Front PSI or Rear PSI (or both).',open:j.part};
   if((req.nums||[]).includes('Torque')&&!supplied[req.nums.indexOf('Torque')])return {ok:false,msg:'Enter specified torque.',open:j.part};
  }else if(supplied.some(v=>!v))return {ok:false,msg:'Fill in every box and your name.',open:j.part};
  const numberValue=(n,i)=>s.id==='fin'?String(Number(supplied[i])):str(a.nums[i],20);
  (req.checks||[]).forEach(c=>j.ticks.push({st:s.id,item:c,name:who,t}));(req.nums||[]).forEach((n,i)=>{if(s.id==='fin'&&!supplied[i])return;j.ticks.push({st:s.id,item:n,value:numberValue(n,i),name:who,t});});
  log(j.part,s.id,'checklist done',who,{action:'done',items:(req.checks||[]).join('; '),nums:(req.nums||[]).map((n,i)=>s.id==='fin'&&!supplied[i]?'':n+'='+numberValue(n,i)).filter(Boolean).join('; ')});advance(j);return {ok:true,msg:j.part+' done'}; }
 case 'batch': { const b=DB.jobs.filter(j=>j.inBatch);if(!b.length)return {ok:false,msg:'Batch is empty.'};
  b.forEach(j=>{j.inBatch=0;j.ticks.push({st:'oven',item:'batch time',value:t});log(j.part,'oven','batch started '+t,'',{action:'batch'});advance(j);});return {ok:true,msg:'Batch started'}; }
 case 'hold': { const j=DB.jobs.find(x=>x.part==a.part&&!x.done);if(!j)return {ok:false,msg:'No such job.'};
  j.hold=!!a.hold;log(j.part,'office',j.hold?'HOLD':'released','',{action:j.hold?'hold':'release'});return {ok:true}; }
 case 'rank': {
  const clear=a.priorityNumber===null||a.priorityNumber==='';
  if(!clear&&(!Number.isSafeInteger(a.priorityNumber)||a.priorityNumber<=0))return {ok:false,code:400,msg:'Priority number must be a positive whole number, or blank to clear.'};
  const j=DB.jobs.find(x=>x.part==str(a.part)&&x.booked==str(a.booked)&&!x.done);
  if(!j)return {ok:false,code:404,msg:'No such open job.'};
  if(clear)delete j.priorityNumber;else j.priorityNumber=a.priorityNumber;
  log(j.part,'office',clear?'Priority number cleared':'Priority number: '+j.priorityNumber,'',{action:'priority-number'});return {ok:true}; }
 case 'priority': {
  if(typeof a.rush!='boolean')return {ok:false,code:400,msg:'Choose Rush or Normal.'};
  const j=DB.jobs.find(x=>x.part==str(a.part)&&x.booked==str(a.booked)&&!x.done);
  if(!j)return {ok:false,code:404,msg:'No such open job.'};
  if((j.rush===true)===a.rush)return {ok:true,ignored:true};
  j.rush=a.rush;log(j.part,'office',a.rush?'Priority: RUSH':'Priority: NORMAL','',{action:'priority'});
  return {ok:true,msg:a.rush?'Job set to Rush':'Job returned to Normal'}; }
 case 'delete': { // office only: remove one job by part + booked time; log/events kept, other jobs untouched
  const k=DB.jobs.findIndex(x=>x.part==str(a.part)&&x.booked==str(a.booked));if(k<0)return {ok:false,code:404,msg:'No such job (already deleted?).'};
  const j=DB.jobs[k];log(j.part,'office',`DELETED job ${j.job} (${j.cust}) at ${(st(step(j))||{name:'done'}).name}${j.inBatch?', removed from oven batch':''}`,'',{action:'delete'});
  DB.jobs.splice(k,1);return {ok:true,msg:'Deleted '+j.part}; }
 }
 return {ok:false,msg:'Unknown action'};
}
const TWS={SCHEMA,ACID_MAX,OVEN_MAX,S,route,step,wheelSize,sum,wheels,due,compare,jobHasTyre,requirements,apply,empty:()=>({jobs:[],log:[],alerts:[]})};
if(typeof globalThis!='undefined')globalThis.TWS=TWS;
})();
