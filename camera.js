// Photo -> part number. Barcode/QR first (phone's own BarcodeDetector, else ZXing), then OCR for stamped/printed text.
// Libraries load from a CDN only the first time the camera is used, so normal scanning stays light.
(function(){
const load=src=>new Promise((ok,bad)=>{const s=document.createElement('script');s.src=src;s.onload=ok;s.onerror=()=>bad(new Error('Could not load reader - check signal'));document.head.appendChild(s);});
async function toCanvas(file,max){const bmp=await createImageBitmap(file);const k=Math.min(1,max/Math.max(bmp.width,bmp.height));
 const c=document.createElement('canvas');c.width=Math.round(bmp.width*k);c.height=Math.round(bmp.height*k);c.getContext('2d').drawImage(bmp,0,0,c.width,c.height);return c;}
async function barcode(c){
 if('BarcodeDetector'in window){try{const r=await new BarcodeDetector().detect(c);if(r[0])return r[0].rawValue;}catch(e){}}
 try{if(!window.ZXing)await load('https://unpkg.com/@zxing/library@0.21.3/umd/index.min.js');
  const h=new Map([[ZXing.DecodeHintType.TRY_HARDER,true]]);const r=new ZXing.MultiFormatReader();r.setHints(h);
  const lum=new ZXing.HTMLCanvasElementLuminanceSource(c);return r.decode(new ZXing.BinaryBitmap(new ZXing.HybridBinarizer(lum))).getText();}catch(e){return '';}}
let worker;
async function ocr(c){if(!window.Tesseract)await load('https://cdn.jsdelivr.net/npm/tesseract.js@5/dist/tesseract.min.js');
 if(!worker){worker=await Tesseract.createWorker('eng');await worker.setParameters({tessedit_char_whitelist:'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789-./'});}
 const {data}=await worker.recognize(c);
 // best guess = longest token with at least one digit (part numbers mix letters and numbers)
 const t=(data.text||'').toUpperCase().split(/\s+/).map(x=>x.replace(/^[-.\/]+|[-.\/]+$/g,'')).filter(x=>x.length>=4&&/\d/.test(x)).sort((a,b)=>b.length-a.length);
 return t[0]||'';}
window.readPartFromPhoto=async(file,status)=>{status('Reading photo...');
 const code=await barcode(await toCanvas(file,1600));if(code)return {code,how:'barcode'};
 status('No barcode - reading the text (first time can take ~20 s)...');
 return {code:await ocr(await toCanvas(file,1200)),how:'text'};};
})();
