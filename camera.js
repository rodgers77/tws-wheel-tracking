// Photo -> part number. Barcode/QR first (phone's own BarcodeDetector, else ZXing), then OCR.
// OCR is tuned for cast/embossed numbers on spokes: tries 4 rotations and 2 contrast treatments,
// then picks the text that best matches known OEM part-number formats. Result is only a suggestion.
(function(){
const load=src=>new Promise((ok,bad)=>{const s=document.createElement('script');s.src=src;s.onload=ok;s.onerror=()=>bad(new Error('Could not load reader - check signal'));document.head.appendChild(s);});
async function toCanvas(file,max){const bmp=await createImageBitmap(file);const k=Math.min(1,max/Math.max(bmp.width,bmp.height));
 const c=document.createElement('canvas');c.width=Math.round(bmp.width*k);c.height=Math.round(bmp.height*k);c.getContext('2d').drawImage(bmp,0,0,c.width,c.height);return c;}
async function barcode(c){
 if('BarcodeDetector'in window){try{const r=await new BarcodeDetector().detect(c);if(r[0])return r[0].rawValue;}catch(e){}}
 try{if(!window.ZXing)await load('https://unpkg.com/@zxing/library@0.21.3/umd/index.min.js');
  const h=new Map([[ZXing.DecodeHintType.TRY_HARDER,true]]);const r=new ZXing.MultiFormatReader();r.setHints(h);
  const lum=new ZXing.HTMLCanvasElementLuminanceSource(c);return r.decode(new ZXing.BinaryBitmap(new ZXing.HybridBinarizer(lum))).getText();}catch(e){return '';}}
// greyscale; mode 'stretch' = global contrast stretch, 'local' = local contrast normalisation (for embossed metal)
function prep(src,mode,rot){const w=src.width,h=src.height,d=src.getContext('2d').getImageData(0,0,w,h).data,n=w*h,g=new Float32Array(n);
 for(let i=0;i<n;i++)g[i]=.299*d[i*4]+.587*d[i*4+1]+.114*d[i*4+2];
 let o=new Float32Array(n);
 if(mode=='stretch'){const s=Float32Array.from(g).sort(),lo=s[n*.02|0],hi=s[n*.98|0]||255;for(let i=0;i<n;i++)o[i]=(g[i]-lo)*255/Math.max(1,hi-lo);}
 else{const r=Math.max(8,Math.round(Math.max(w,h)/40)),W=w+1,I=new Float64Array(W*(h+1)),Q=new Float64Array(W*(h+1));
  for(let y=0;y<h;y++){let a=0,b=0;for(let x=0;x<w;x++){const v=g[y*w+x];a+=v;b+=v*v;I[(y+1)*W+x+1]=I[y*W+x+1]+a;Q[(y+1)*W+x+1]=Q[y*W+x+1]+b;}}
  for(let y=0;y<h;y++){const y0=Math.max(0,y-r),y1=Math.min(h,y+r+1);for(let x=0;x<w;x++){const x0=Math.max(0,x-r),x1=Math.min(w,x+r+1),A=(y1-y0)*(x1-x0);
   const S=I[y1*W+x1]-I[y0*W+x1]-I[y1*W+x0]+I[y0*W+x0],SQ=Q[y1*W+x1]-Q[y0*W+x1]-Q[y1*W+x0]+Q[y0*W+x0],m=S/A,sd=Math.sqrt(Math.max(0,SQ/A-m*m));
   o[y*w+x]=128+(g[y*w+x]-m)*60/Math.max(sd,6);}}}
 const c=document.createElement('canvas'),sw=rot%180?h:w,sh=rot%180?w:h;c.width=sw;c.height=sh;const t=document.createElement('canvas');t.width=w;t.height=h;
 const tx=t.getContext('2d'),id=tx.createImageData(w,h);for(let i=0;i<n;i++){const v=Math.max(0,Math.min(255,o[i]));id.data[i*4]=id.data[i*4+1]=id.data[i*4+2]=v;id.data[i*4+3]=255;}tx.putImageData(id,0,0);
 const x=c.getContext('2d');x.translate(sw/2,sh/2);x.rotate(rot*Math.PI/180);x.drawImage(t,-w/2,-h/2);return c;}
// Known OEM formats (score = how sure). Digit-only slots get O->0, I->1 etc. fixes.
const FMT=[[/\b\d{5}-?[A-Z][A-Z0-9]{4}\b/,'hk',10],[/\b\d{5}-[A-Z0-9]{5}\b/,'hk',6],[/\bA\d{10}\b/,'',10],[/\b\d{11}\b/,'',9],[/\b\d[A-Z]\d{7}[A-Z]{0,2}\b/,'',9],[/\b[A-Z0-9]{2,3}\d{6}[A-Z]{0,2}\b/,'',5]];
const fixD=s=>s.replace(/[OQD]/g,'0').replace(/[IL]/g,'1').replace(/S/g,'5').replace(/B/g,'8').replace(/Z/g,'2').replace(/G/g,'6');
function pick(text){let best={code:'',score:0};
 for(let line of (text||'').toUpperCase().split('\n')){line=line.replace(/[^A-Z0-9-]/g,'');if(line.length<7)continue;
  if(/DATE|LOT|MADE|ET\d|X\d\d/.test(line))continue;
  const vars=[line,line.replace(/^(.{5})/,m=>fixD(m))];
  for(const v of vars)for(const [re,kind,sc] of FMT){const m=v.match(re);if(!m)continue;let c=m[0];
   if(kind=='hk'){c=c.replace('-','');c=c.slice(0,5)+'-'+c.slice(5);}
   const s=sc+(v==line?.5:0);if(s>best.score)best={code:c,score:s};}}
 return best;}
let worker;
async function ocr(c,status){if(!window.Tesseract)await load('https://cdn.jsdelivr.net/npm/tesseract.js@5/dist/tesseract.min.js');
 if(!worker){worker=await Tesseract.createWorker('eng');await worker.setParameters({tessedit_char_whitelist:'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789-',tessedit_pageseg_mode:'11'});}
 let best={code:'',score:0};
 for(const mode of ['stretch','local'])for(const rot of [0,90,270,180]){status&&status('Reading text ('+mode+', '+rot+'°)...');
  const {data}=await worker.recognize(prep(c,mode,rot));const b=pick(data.text);if(b.score>best.score)best=b;if(best.score>=10)return best.code;}
 return best.code;}
window.__pickPart=pick;window.__prep=prep;
// Shrink to ~1024px JPEG and ask the shared Worker's AI reader (best for cast numbers on spokes).
async function aiRead(file){const api=typeof API=='string'&&API;if(!api||!localStorage.pin)return '';
 const c=await toCanvas(file,1024),blob=await new Promise(ok=>c.toBlob(ok,'image/jpeg',0.82));
 const ac=new AbortController(),t=setTimeout(()=>ac.abort(),15000);
 try{const r=await fetch(api+'/read-part',{method:'POST',body:blob,signal:ac.signal,headers:{'Content-Type':'image/jpeg','X-PIN':localStorage.pin}});
  if(!r.ok)return '';const d=await r.json();return d.code||'';}catch(e){return '';}finally{clearTimeout(t);}}
window.readPartFromPhoto=async(file,status)=>{status('Reading photo...');
 const ai=await aiRead(file);if(ai)return {code:ai,how:'photo'};
 const code=await barcode(await toCanvas(file,1600));if(code)return {code,how:'barcode'};
 status('No barcode - reading the text on this phone (first time can take ~20 s)...');
 return {code:await ocr(await toCanvas(file,1400),status),how:'text'};};
})();
