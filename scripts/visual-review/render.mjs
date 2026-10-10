
import http from "node:http";
import path from "node:path";
import fs from "node:fs/promises";
import { chromium } from "playwright";
const base=path.join(process.cwd(),"scripts/visual-review/dist");
const screenshots=path.join(process.cwd(),"scripts/visual-review/screenshots");
await fs.mkdir(screenshots,{recursive:true});
const mime={".html":"text/html",".js":"text/javascript",".css":"text/css"};
const server=http.createServer(async(req,res)=>{
  const pathname=new URL(req.url||"/", "http://127.0.0.1").pathname;
  const rel=pathname==="/"?"/index.html":pathname;
  const filename=path.resolve(base,"."+rel);
  if(!filename.startsWith(base+path.sep)) {res.writeHead(403).end();return}
  try {
    const bytes=await fs.readFile(filename);
    res.writeHead(200,{"content-type":mime[path.extname(filename)]||"application/octet-stream"});
    res.end(bytes);
  }catch{res.writeHead(404).end("Not Found")}
});
await new Promise(resolve=>server.listen(0,"127.0.0.1",resolve));
const port=server.address().port, browser=await chromium.launch({headless:true,args:["--no-sandbox"]});
const pages=["today","study","lesson","lesson-exercise","capture","insights","vocabulary","note-review","family","settings"];
const sizes=[["desktop",1440,1000],["mobile",390,844]];
try{
for(const [size,w,h] of sizes) {
 for(const name of pages){
  const page=await browser.newPage({viewport:{width:w,height:h},deviceScaleFactor:1});
  const errors=[];
  page.on("pageerror",e=>errors.push(e.message));
  await page.goto(`http://127.0.0.1:${port}/?page=${name}&size=${size}`,{waitUntil:"domcontentloaded"});
  await page.waitForTimeout(name==="family"?1500:900);
  if(name==="family"){
   const dialog=page.locator("dialog.family-dialog");
   await dialog.waitFor({state:"visible",timeout:10000}).catch(()=>{});
  }
  if(name==="vocabulary")await page.waitForTimeout(500);
  const expected = {study:".review-editorial-stage", lesson:".lesson-editorial-content", "lesson-exercise":".lesson-exercise-editorial"}[name];
  if(expected && !(await page.locator(expected).isVisible()))throw Error(`Missing expected source component: ${name} ${size} ${expected}. Errors: ${errors.join(" | ")}`);
  if(name==="study"){
    const unknown=page.getByRole("button",{name:"不会",exact:true});
    if(!(await unknown.isVisible()))throw Error("Review skip action is missing or renamed");
  }
  if(name==="lesson" && !(await page.getByRole("button",{name:"词族",exact:true}).isVisible()))
    throw Error("Word-family entry is not visible in lesson explanation");
  if(name==="capture" && size==="mobile"){
    const h=page.locator("#capture-notes-title");
    const layout=await h.evaluate(el=>({
      whiteSpace:getComputedStyle(el).whiteSpace, height:el.getBoundingClientRect().height,
      lineHeight:parseFloat(getComputedStyle(el).lineHeight),
      width:el.getBoundingClientRect().width,
      available:el.parentElement?.getBoundingClientRect().width??0
    }));
    if(layout.whiteSpace!=="nowrap" || layout.height>layout.lineHeight*1.4 || layout.width>layout.available+1)
      throw Error("Capture title must stay on one line: "+JSON.stringify(layout));
  }
  const overflow=await page.evaluate(()=>document.documentElement.scrollWidth > window.innerWidth + 8);
  if(overflow)console.warn(`WARN: horizontal overflow at ${name} ${size}`);
  if(errors.length)console.warn(`WARN: page errors at ${name} ${size}: ${errors.join(" | ")}`);
  await page.screenshot({path:path.join(screenshots,`${name}-${size}.png`),fullPage:true,animations:"disabled"});
  console.log(`${name}-${size}: screenshot captured. Page errors: ${errors.slice(0,3).join(" | ")||"none"}`);
  await page.close();
 }
}
}finally{await browser.close();await new Promise(resolve=>server.close(resolve))}
