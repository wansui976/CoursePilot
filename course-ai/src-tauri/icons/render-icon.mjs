import { createRequire } from 'module'; import fs from 'fs'; const { chromium } = createRequire(import.meta.url)('playwright');
const [,, src, out, size='1024'] = process.argv; const s=+size;
const b = await chromium.launch(); const p = await b.newPage({viewport:{width:s,height:s}});
const svg = fs.readFileSync(src,'utf8').replace(/width="1024" height="1024"/, `width="${s}" height="${s}"`);
await p.setContent(`<html><body style="margin:0;background:transparent">${svg}</body></html>`);
await p.screenshot({path:out, omitBackground:true, clip:{x:0,y:0,width:s,height:s}}); await b.close();
