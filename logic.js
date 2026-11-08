// TWS wheel tracking rules. Shared by the phone app (local mode) and the Cloudflare Worker (shared mode),
// so the strict order and the acid 8 / oven 6 limits are enforced the same way in both places.
(function(){
const ACID_MAX = 8, OVEN_MAX = 6;
// Ian, 5 Nov: 7 checkpoints. Acid is ONE scan (in acid until scanned at Prep). Lacquer is the final step
// (covers old cooling, tyre fit & balance, ready, fit to car); finishing it completes the job and alerts the Office.
// Office Hold/Release is a job-list button, not a station.
const S = [
 {id:'rec',name:'1 Reception'},
 {id:'wm',name:'2 Wheel machine (book-in)',checks:[]},
 {id:'acid',name:'3 Acid room',checks:['No inserts','No weights','No valves','Tyre off and stored','TPMS sensor kept with tyre']},
 {id:'prep',name:'4 Prep',checks:['Part number approved','Hub taped','Imperfections sanded']},
 {id:'oven',name:'5 Oven',batch:true},
 {id:'cut',name:'6 Diamond cut',checks:['Cut done']},
 {id:'lac',name:'7 Lacquer',checks:['Cooled by wheel machine','Tyre fitted','TPMS sensor fitted','Valves fitted','Hub sanded, balanced (no counterbalancing)','Fitted to car / ready for collection, confirmed done'],nums:['PSI before balancing','PSI','Torque']}];
// Diamond cut wheels go back in the oven after cutting (lacquer bake), as before.
const route = j => ['wm','acid','prep','oven', ...(j.finish=='Diamond cut'?['cut','oven']:[]),'lac'];
const step = j => route(j)[j.pos];
const sum = b => b.reduce((a,j)=>a+ +j.n,0);
// Wheels in acid = scanned into acid, not yet taken at Prep.
const wheels = (DB,id) => sum(DB.jobs.filter(j=>!j.done&&step(j)==id));
// Next due = oldest booked job at this step, not on hold, not in an oven batch, not claimed by ANOTHER phone.
const due = (DB,id,dev) => DB.jobs.filter(j=>!j.done&&!j.hold&&step(j)==id&&!j.inBatch&&!(j.claim&&j.claim.dev!=dev))
  .sort((a,b)=>a.booked<b.booked?-1:1)[0];
const st = id => S.find(s=>s.id==id);
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
  log(d.part,s.id,'scanned','',{action:'scan'});
  if(!(s.checks||[]).length&&!(s.nums||[]).length){advance(d);return {ok:true,msg:d.part+' booked in at wheel machine'};}
  d.claim={st:s.id,dev};return {ok:true,open:d.part}; }
 case 'tick': { const j=DB.jobs.find(x=>x.part==a.part&&!x.done), who=str(a.who,60);
  if(!s||!j||step(j)!=s.id||!j.claim||j.claim.dev!=dev)return {ok:false,msg:'That wheel is not open on this phone any more - scan again.'};
  if(!(s.checks||[]).every((c,i)=>a.checks&&a.checks[i]))return {ok:false,msg:'Tick every item first.',open:j.part};
  if(!who||(s.nums||[]).some((n,i)=>!str(a.nums&&a.nums[i])))return {ok:false,msg:'Fill in every box and your name.',open:j.part};
  (s.checks||[]).forEach(c=>j.ticks.push({st:s.id,item:c,name:who,t}));(s.nums||[]).forEach((n,i)=>j.ticks.push({st:s.id,item:n,value:str(a.nums[i],20),name:who,t}));
  log(j.part,s.id,'checklist done',who,{action:'done',items:(s.checks||[]).join('; '),nums:(s.nums||[]).map((n,i)=>n+'='+str(a.nums[i],20)).join('; ')});advance(j);return {ok:true,msg:j.part+' done'}; }
 case 'batch': { const b=DB.jobs.filter(j=>j.inBatch);if(!b.length)return {ok:false,msg:'Batch is empty.'};
  b.forEach(j=>{j.inBatch=0;j.ticks.push({st:'oven',item:'batch time',value:t});log(j.part,'oven','batch started '+t,'',{action:'batch'});advance(j);});return {ok:true,msg:'Batch started'}; }
 case 'hold': { const j=DB.jobs.find(x=>x.part==a.part&&!x.done);if(!j)return {ok:false,msg:'No such job.'};
  j.hold=!!a.hold;log(j.part,'office',j.hold?'HOLD':'released','',{action:j.hold?'hold':'release'});return {ok:true}; }
 }
 return {ok:false,msg:'Unknown action'};
}
const TWS={ACID_MAX,OVEN_MAX,S,route,step,sum,wheels,due,apply,empty:()=>({jobs:[],log:[],alerts:[]})};
if(typeof globalThis!='undefined')globalThis.TWS=TWS;
})();
