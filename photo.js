// Booking photo of the FRONT of the wheel: shrink on the phone, then a quick advisory blur/dark check.
// Pure maths in quality() so it can be tested without a browser.
(function(){
// rgba: RGBA bytes, w x h (already small, ~320 px wide). Returns brightness 0-255 and Laplacian variance (sharpness).
function quality(rgba,w,h){const g=new Float32Array(w*h);let sum=0;
 for(let i=0;i<w*h;i++){g[i]=.299*rgba[i*4]+.587*rgba[i*4+1]+.114*rgba[i*4+2];sum+=g[i];}
 let n=0,m=0,m2=0;for(let y=1;y<h-1;y++)for(let x=1;x<w-1;x++){const i=y*w+x,l=4*g[i]-g[i-1]-g[i+1]-g[i-w]-g[i+w];n++;const d=l-m;m+=d/n;m2+=d*(l-m);}
 const brightness=sum/(w*h),sharpness=n?m2/n:0;
 const issues=[];if(brightness<45)issues.push('dark');else if(brightness>235)issues.push('washed out');if(sharpness<25)issues.push('blurry');
 return {brightness:Math.round(brightness),sharpness:Math.round(sharpness),issues};}
const canvasOf=(src,max)=>{const k=Math.min(1,max/Math.max(src.width,src.height)),c=document.createElement('canvas');
 c.width=Math.max(1,Math.round(src.width*k));c.height=Math.max(1,Math.round(src.height*k));c.getContext('2d').drawImage(src,0,0,c.width,c.height);return c;};
// file -> {dataUrl (JPEG, max 800 px), q (quality)}. Steps down if still too big for the server limit.
async function prepare(file,limit){const bmp=await createImageBitmap(file);let url='';
 for(const [max,qual] of [[800,.6],[640,.5],[480,.45]]){url=canvasOf(bmp,max).toDataURL('image/jpeg',qual);if(url.length<=limit)break;}
 const s=canvasOf(bmp,320),d=s.getContext('2d').getImageData(0,0,s.width,s.height);
 return {dataUrl:url,q:quality(d.data,s.width,s.height)};}
const TWSPhoto={quality,prepare};
if(typeof globalThis!='undefined')globalThis.TWSPhoto=TWSPhoto;
})();
