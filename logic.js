// TWS wheel tracking rules. Shared by the phone app (local mode) and the Cloudflare Worker (shared mode),
// so the strict order and the acid 8 / oven 6 limits are enforced the same way in both places.
(function(){
const ACID_MAX = 8, OVEN_MAX = 6;
// Ian, 2 Nov: fitting is TWO steps: 11 "Tyre fit & balance" then 13 "Fit to car". Results report to the Office.
const S = [
 {id:'rec',name:'1 Reception'},
 {id:'wm',name:'2 Wheel machine (book-in)',checks:[]},
 {id:'office',name:'3 Office / Hold / Status'},
 {id:'strip',name:'4 Strip-down',checks:['Tyre off and stored','TPMS sensor kept with tyre','Valve out','Weights out','Buckle check']},
 {id:'acid',name:'5 Acid room - in',checks:['No inserts','No weights','No valves']},
 {id:'acidout',name:'6 Out of acid',checks:['Dipped, free of residue','Rinsed','Laid by prep']},
 {id:'prep',name:'7 Prep',checks:['Part number approved','Hub taped','Imperfections sanded']},
 {id:'oven',name:'8 Oven',batch:true},
 {id:'cut',name:'9 Diamond cut',checks:['Cut done']},
 {id:'cool',name:'10 After lacquer - cooling',checks:['Out to cool by wheel machine']},
 {id:'fitm',name:'11 Tyre fit & balance',checks:['Tyre fitted','TPMS sensor fitted','Valves fitted','Hub sanded, balanced (no counterbalancing)'],nums:['PSI before balancing']},
 {id:'ready',name:'12 Ready',checks:['Ready for the wheel']},
 {id:'fit',name:'13 Fit to car',checks:['Fitted to car, confirmed done'],nums:['PSI','Torque']}];
const route = j => ['wm','strip','acid','acidout','prep','oven', ...(j.finish=='Diamond cut'?['cut','oven']:[]),'cool','fitm','ready','fit'];
const step = j => route(j)[j.pos];
const sum = b => b.reduce((a,j)=>a+ +j.n,0);
const wheels = (DB,id) => sum(DB.jobs.filter(j=>!j.done&&step(j)==id));
// Next due = oldest booked job at this step, not on hold, not in an oven batch, not claimed by ANOTHER phone.
const due = (DB,id,dev) => DB.jobs.filter(j=>!j.done&&!j.hold&&step(j)==id&&!j.inBatch&&!(j.claim&&j.claim.dev!=dev))
  .sort((a,b)=>a.booked<b.booked?-1:1)[0];
const st = id => S.find(s=>s.id==id);
const str = (v,n=80) => String(v??'').replace(/[\r\n\t]+/g,' ').trim().slice(0,n);
// Apply one action to the state. Returns {ok, msg, open?}. Mutates DB.
function apply(DB, a, t){
 t = t || new Date().toISOString(); const dev = str(a.dev,40);
 const log = (job,station,what,name='')=>{DB.log.push({t,job,station,what,name});if(DB.log.length>3000)DB.log.splice(0,DB.log.length-3000);};
 const alertOffice = m=>{DB.alerts.push({t,msg:m});if(DB.alerts.length>500)DB.alerts.shift();log('',str(a.st),'ALERT: '+m);};
 const advance = j=>{j.claim=null;j.pos++;if(j.pos>=route(j).length){j.done=1;alertOffice(`Job complete: ${j.part} (${j.cust}, job ${j.job})`);}};
 const s = st(a.st);
 switch(a.type){
 case 'book': { const j={}; for(const k of ['part','job','cust','tyre','make','reg','staying','tyreinc'])j[k]=str(a.job&&a.job[k]);
  j.n=Math.max(1,Math.min(4,parseInt(a.job&&a.job.n)||0)); j.finish=(a.job&&a.job.finish)=='Diamond cut'?'Diamond cut':'Powder coat';
  if(!j.part||!j.cust)return {ok:false,msg:'Part number and customer needed.'};
  if(DB.jobs.some(x=>x.part==j.part&&!x.done))return {ok:false,msg:'Part number already in workshop - mark triangle/square variant.'};
  Object.assign(j,{booked:t,pos:0,ticks:[]});DB.jobs.push(j);log(j.part,'rec','booked in');return {ok:true,msg:'Booked in '+j.part}; }
 case 'scan': { if(!s||!route({}).concat('cut').includes(s.id))return {ok:false,msg:'Not a scanning station.'};
  const code=str(a.code), d=due(DB,s.id,dev);
  if(!d||d.part!=code){alertOffice(`Wrong scan at ${s.name}: ${code}${d?' (expected '+d.part+')':''}`);
   return {ok:false,msg:`REJECTED: ${code} is not the next wheel due here${d?' (next is '+d.part+')':''}. Office notified.`};}
  if(s.id=='acid'&&wheels(DB,'acidout')+ +d.n>ACID_MAX)return {ok:false,msg:`Acid full: max ${ACID_MAX} wheels.`};
  if(s.batch){if(sum(DB.jobs.filter(j=>j.inBatch))+ +d.n>OVEN_MAX)return {ok:false,msg:`Oven batch full: max ${OVEN_MAX} wheels.`};
   d.inBatch=1;log(d.part,'oven','added to batch');return {ok:true,msg:d.part+' added to batch'};}
  log(d.part,s.id,'scanned');
  if(!(s.checks||[]).length&&!(s.nums||[]).length){advance(d);return {ok:true,msg:d.part+' booked in at wheel machine'};}
  d.claim={st:s.id,dev};return {ok:true,open:d.part}; }
 case 'tick': { const j=DB.jobs.find(x=>x.part==a.part&&!x.done), who=str(a.who,60);
  if(!s||!j||step(j)!=s.id||!j.claim||j.claim.dev!=dev)return {ok:false,msg:'That wheel is not open on this phone any more - scan again.'};
  if(!(s.checks||[]).every((c,i)=>a.checks&&a.checks[i]))return {ok:false,msg:'Tick every item first.',open:j.part};
  if(!who||(s.nums||[]).some((n,i)=>!str(a.nums&&a.nums[i])))return {ok:false,msg:'Fill in every box and your name.',open:j.part};
  (s.checks||[]).forEach(c=>j.ticks.push({st:s.id,item:c,name:who,t}));(s.nums||[]).forEach((n,i)=>j.ticks.push({st:s.id,item:n,value:str(a.nums[i],20),name:who,t}));
  log(j.part,s.id,'checklist done',who);advance(j);return {ok:true,msg:j.part+' done'}; }
 case 'batch': { const b=DB.jobs.filter(j=>j.inBatch);if(!b.length)return {ok:false,msg:'Batch is empty.'};
  b.forEach(j=>{j.inBatch=0;j.ticks.push({st:'oven',item:'batch time',value:t});log(j.part,'oven','batch started '+t);advance(j);});return {ok:true,msg:'Batch started'}; }
 case 'hold': { const j=DB.jobs.find(x=>x.part==a.part&&!x.done);if(!j)return {ok:false,msg:'No such job.'};
  j.hold=!!a.hold;log(j.part,'office',j.hold?'HOLD':'released');return {ok:true}; }
 }
 return {ok:false,msg:'Unknown action'};
}
const TWS={ACID_MAX,OVEN_MAX,S,route,step,sum,wheels,due,apply,empty:()=>({jobs:[],log:[],alerts:[]})};
if(typeof globalThis!='undefined')globalThis.TWS=TWS;
})();
