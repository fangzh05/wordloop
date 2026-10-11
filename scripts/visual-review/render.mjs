
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
const pages=["lesson","lesson-dark","lesson-exercise","pretest","pretest-dark","pretest-correct","pretest-wrong","pretest-loading","study","study-dark","review-correct","review-wrong","review-loading","lesson-feedback","lesson-feedback-retry","lesson-feedback-loading","consolidation-feedback","consolidation-retry","consolidation-loading","today","capture","insights","vocabulary","note-review","family","settings"];
const requestedPages=process.env.VISUAL_PAGES?.trim().split(",").map(v=>v.trim()).filter(Boolean);
const visualPages=requestedPages?.length?requestedPages:pages;
const sizes=[["desktop",1440,1000],["mobile",390,844]];
try{
for(const [size,w,h] of sizes) {
 for(const name of visualPages){
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
  const expected = {study:".review-editorial-stage","study-dark":".review-editorial-stage","review-correct":".review-editorial-stage","review-wrong":".review-editorial-stage","review-loading":".review-editorial-stage",
    lesson:".lesson-reference-stage","lesson-dark":".lesson-reference-stage","relearn-lesson":".lesson-reference-stage","relearn-lesson-dark":".lesson-reference-stage","relearn-exercise":".lesson-exercise-editorial","lesson-exercise":".lesson-exercise-editorial",
    pretest:".pretest-editorial-workspace","pretest-dark":".pretest-editorial-workspace","pretest-correct":".pretest-result-editorial","pretest-wrong":".pretest-result-editorial","pretest-loading":".pretest-editorial-workspace",
    "consolidation-feedback":".lesson-feedback-editorial","consolidation-retry":".lesson-feedback-editorial","consolidation-loading":".lesson-feedback-editorial"}[name];
  if(expected && !(await page.locator(expected).isVisible()))throw Error(`Missing expected source component: ${name} ${size} ${expected}. Errors: ${errors.join(" | ")}`);
  if(["study","study-dark","review-correct","review-wrong","review-loading"].includes(name)){
    const unknown=page.getByRole("button",{name:"不会",exact:true});
    if(!(await unknown.isVisible()))throw Error("Review skip action is missing or renamed");
    if(size==="mobile"){
      const rect=await unknown.boundingBox();
      if(!rect || rect.height>65 || rect.height<42)throw Error("Mobile 不会 button height should be compact, measured: "+JSON.stringify(rect));
    }
  }
  if(["lesson","lesson-dark","relearn-lesson","relearn-lesson-dark"].includes(name) && !(await page.getByRole("button",{name:"词族",exact:true}).isVisible()))
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
  if(name.startsWith("lesson-feedback")) {
    const feedback=page.locator(".lesson-feedback-editorial");
    if(!(await feedback.isVisible()))throw Error(`Missing source feedback component in ${name} ${size}`);
    const button=feedback.locator(".lesson-feedback-primary");
    if(!(await button.isVisible()))throw Error("Missing primary feedback action");
    const style=await page.evaluate(()=>{
      const card=document.querySelector(".lesson-card:has(.lesson-feedback-editorial)");
      const content=document.querySelector(".lesson-card > .lesson-feedback-editorial");
      const s=card?getComputedStyle(card):null;
      const c=content?getComputedStyle(content):null;
      return s&&c?{border:s.borderTopWidth,radius:s.borderTopLeftRadius,shadow:s.boxShadow,display:s.display,innerBorder:c.borderTopWidth,innerRadius:c.borderTopLeftRadius,innerShadow:c.boxShadow,innerBackground:c.backgroundColor}:null;
    });
    if(!style || style.border!=="0px" || style.radius!=="0px" || style.display!=="block" || style.innerBorder!=="0px" || style.innerRadius!=="0px" || style.innerShadow!=="none")
      throw Error(`Unexpected outer feedback card styling: ${JSON.stringify(style)}`);
    const label=(await button.innerText()).trim();
    const expectedLabel=name==="lesson-feedback-retry"?"重做当前题":name==="lesson-feedback-loading"?"正在生成下一词":"下一词";
    if(!label.includes(expectedLabel))throw Error(`Incorrect button: ${label} vs ${expectedLabel}`);
    if(name==="lesson-feedback-loading" && !(await button.isDisabled()))throw Error("Next-word button must be disabled while generating");
  }
  if(["lesson","lesson-dark","relearn-lesson","relearn-lesson-dark"].includes(name)){
    const audio=page.getByRole("button",{name:/播放发音|朗读单词/});
    if(!(await audio.isVisible())||await audio.locator("svg.lesson-play-glyph").count()!==1)
      throw Error("Lesson audio control must use actual monochrome SVG");
    if(await audio.innerText())throw Error("Unexpected emoji/text play glyph in lesson button");
    const tone=await audio.evaluate(el=>({bg:getComputedStyle(el).backgroundColor,border:getComputedStyle(el).borderTopWidth,icon:getComputedStyle(el).color,diameter:el.getBoundingClientRect().width}));
    if(tone.border!=="0px"||tone.diameter<28||tone.diameter>37)throw Error("Audio control does not match accepted indulge reference: "+JSON.stringify(tone));
  }
  if(["relearn-lesson","relearn-lesson-dark"].includes(name)){
    const progress=await page.locator(".lesson-reference-progress-label").innerText();
    if(!progress.includes("复习补学 1 / 32"))throw Error("Relearn session header missing: "+progress);
    const terms=await page.locator(".lesson-reference-title").innerText();
    if(terms.trim()!=="indulge")throw Error("Relearn word mismatch");
  }
  if(["pretest","pretest-dark"].includes(name)){
    if(await page.getByText("Write the word",{exact:true}).count())throw Error("Decorative Write the word heading must be removed");
    if(!(await page.locator(".pretest-meaning").isVisible()))throw Error("Chinese prompt must be prominent");
  }
  if(name.startsWith("pretest")){
    const card=page.locator(".pretest-editorial-card");
    if(!(await card.isVisible()))throw Error("Pretest card missing");
    const st=await card.evaluate(el=>({border:getComputedStyle(el).borderTopWidth,radius:getComputedStyle(el).borderTopLeftRadius}));
    if(st.border!=="0px" || st.radius!=="0px")throw Error("Pretest outer border must be removed: "+JSON.stringify(st));
    const button=page.getByRole("button",{name:"不会",exact:true});
    if(["pretest","pretest-dark","pretest-loading"].includes(name)&&!(await button.isVisible()))throw Error("Pretest unknown action missing");
    if(name==="pretest-wrong"&&!(await page.getByRole("button",{name:"我本来会这个词"}).isVisible()))throw Error("Original familiar-word action missing");
    if(name==="pretest-loading"&&!(await button.isDisabled()))throw Error("Loading pretest button must be disabled");
  }
  if(name.startsWith("consolidation-")){
    const btn=page.locator(".lesson-feedback-primary");
    const label=(await btn.innerText()).trim();
    const wanted=name==="consolidation-retry"?"修改一次":name==="consolidation-loading"?"正在继续学习":"继续学习";
    if(!label.includes(wanted))throw Error(`Wrong consolidation UI label ${label} for ${name}`);
  }
  if(name.endsWith("-dark")){
    const theme=await page.evaluate(()=>document.documentElement.dataset.theme);
    if(theme!=="dark")throw Error("Dark mode not enabled");
  }
  // Protect the user-approved PR #3 typography from future visual-only overrides.
  if(["lesson-exercise","relearn-exercise"].includes(name)){
    const fonts=await page.evaluate(()=>{
      const h=document.querySelector(".lesson-exercise-heading");
      const input=document.querySelector(".lesson-exercise-answer .standalone-input");
      return {heading:h?getComputedStyle(h).fontFamily:"",input:input?getComputedStyle(input).fontFamily:""};
    });
    if(!/Songti|STSong|Noto Serif CJK/.test(fonts.heading))throw Error("Lesson heading must retain original PR3 Chinese display font: "+JSON.stringify(fonts));
    if(/Iowan|Baskerville|Georgia/.test(fonts.input))throw Error("Do not force English display typeface onto lesson input: "+JSON.stringify(fonts));
  }
  if(name==="pretest"){
    const fonts=await page.evaluate(()=>{
      const meaning=document.querySelector(".pretest-meaning");
      const input=document.querySelector(".pretest-editorial-input");
      return {meaning:meaning?getComputedStyle(meaning).fontFamily:"",input:input?getComputedStyle(input).fontFamily:""};
    });
    if(/Songti|STSong|Baskerville|Georgia/.test(fonts.meaning)||/Iowan|Baskerville|Georgia/.test(fonts.input))
      throw Error("Pretest must retain original system UI fonts for Chinese and input: "+JSON.stringify(fonts));
  }
  // All rectangular buttons in the study flow share the approved pretest
  // 8px radius; audio remains a circle and is deliberately excluded.
  const radiusTargets={
    pretest:[".pretest-editorial-actions > .pretest-unknown-button",".pretest-editorial-actions > .pretest-submit-button"],
    "pretest-dark":[".pretest-editorial-actions > .pretest-unknown-button",".pretest-editorial-actions > .pretest-submit-button"],
    "pretest-wrong":[".pretest-result-actions > .pretest-main-button",".pretest-result-actions .familiar-action"],
    study:[".review-answer-bottom > .review-unknown-button",".review-answer-bottom > .review-submit-button"],
    lesson:[".lesson-reference-bottom > .button"],
    "relearn-lesson":[".lesson-reference-bottom > .button"],
    "relearn-lesson-dark":[".lesson-reference-bottom > .button"],
    "relearn-exercise":[".lesson-exercise-actions > .button"],
    "lesson-exercise":[".lesson-exercise-actions > .button"],
    "lesson-feedback":[".lesson-feedback-footer > .button"],
    "lesson-feedback-retry":[".lesson-feedback-footer > .button"],
    "lesson-feedback-loading":[".lesson-feedback-footer > .button"]
  }[name] ?? [];
  for(const selector of radiusTargets){
    const action=page.locator(selector).first();
    if(!(await action.isVisible()))throw Error(`Missing corner check target ${name}: ${selector}`);
    const corners=await action.evaluate(el=>{
      const s=getComputedStyle(el);
      return [s.borderTopLeftRadius,s.borderTopRightRadius,s.borderBottomRightRadius,s.borderBottomLeftRadius];
    });
    if(corners.some(c=>c!=="8px"))throw Error(`Inconsistent corner radius on ${name}: ${selector}: ${corners.join(",")}`);
  }
  if(["lesson","relearn-lesson","relearn-lesson-dark"].includes(name)){
    const audio=page.locator(".lesson-reference-ipa .lesson-audio");
    const radius=await audio.evaluate(el=>getComputedStyle(el).borderTopLeftRadius);
    if(radius!=="50%")throw Error("Audio icon must remain circular: "+radius);
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
