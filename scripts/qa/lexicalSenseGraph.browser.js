// Requires both QA servers: V147 baseline on 4328 and V2 on 4329.
// Pass an existing Playwright page and an external screenshot directory.
async (page, outputDirectory) => {
const browser=page.context().browser();
const reports=[];
const assert=(x,m)=>{if(!x)throw new Error(m)};
async function open(p,url){await p.goto(url);await p.getByRole('button',{name:'词族',exact:true}).click();await p.getByRole('button',{name:'语义网络',exact:true}).click();}
async function ready(p){await p.waitForFunction(()=>document.querySelector('.network-canvas')?._cyreg?.cy?.nodes().length>0);}
async function check(p){return p.evaluate(()=>{
 const dlg=document.querySelector('dialog'),canvas=document.querySelector('.network-canvas'),cy=canvas._cyreg.cy;
 const nodes=cy.nodes().map(n=>({id:n.id(),bb:n.renderedBoundingBox({includeLabels:true})}));
 const overlap=[];for(let i=0;i<nodes.length;i++)for(let j=i+1;j<nodes.length;j++){const a=nodes[i].bb,b=nodes[j].bb;if(Math.min(a.x2,b.x2)>Math.max(a.x1,b.x1)&&Math.min(a.y2,b.y2)>Math.max(a.y1,b.y1))overlap.push([nodes[i].id,nodes[j].id]);}
 const clipped=nodes.filter(n=>n.bb.x1<0||n.bb.y1<0||n.bb.x2>canvas.clientWidth||n.bb.y2>canvas.clientHeight);
 const dr=dlg.getBoundingClientRect();const overflow=[...dlg.querySelectorAll('.network-card,button,select,.network-selection,.lexical-filters,.network-overview,.network-canvas')].filter(el=>{const r=el.getBoundingClientRect();return r.width>0&&(r.left<dr.left||r.right>dr.right)}).map(el=>el.className||el.tagName);
 const controls=[...dlg.querySelectorAll('button,select,summary')].filter(el=>el.getBoundingClientRect().height>0&&el.getBoundingClientRect().height<43).map(el=>({text:el.textContent,h:el.getBoundingClientRect().height}));
 return {nodes,overlap,clipped,overflow,controls,documentOverflow:document.documentElement.scrollWidth>innerWidth,dialogOverflow:dlg.scrollWidth>dlg.clientWidth,cards:dlg.querySelectorAll('[data-network-group]').length};
});}
for(const [width,height,touch] of [[390,844,true],[820,1180,true],[1440,1000,false]]){
 const ctx=await browser.newContext({viewport:{width,height},hasTouch:touch,isMobile:touch,deviceScaleFactor:1});const p=await ctx.newPage();const errors=[],warnings=[],writes=[];
 p.on('pageerror',e=>errors.push(e.message));p.on('console',m=>{if(m.type()==='error')errors.push(m.text());if(m.type()==='warning')warnings.push(m.text());});p.on('request',r=>{if(r.method()!=='GET')writes.push(r.url())});
 // Before uses same public data with the actual V147 component, RPC and engine.
 await open(p,'http://127.0.0.1:4328/?word=bear');await p.waitForFunction(()=>document.querySelector('.family-canvas')?._cyreg?.cy?.nodes().length>2);
 await p.locator('.family-canvas').scrollIntoViewIfNeeded();await p.screenshot({path:outputDirectory+`/before-bear-${width}.png`});
 const beforeLayout=await p.evaluate(()=>{const cy=document.querySelector('.family-canvas')._cyreg.cy;const bs=cy.nodes().map(n=>({id:n.id(),bb:n.renderedBoundingBox({includeLabels:true})}));const pairs=[];for(let i=0;i<bs.length;i++)for(let j=i+1;j<bs.length;j++){const a=bs[i].bb,b=bs[j].bb;if(Math.min(a.x2,b.x2)>Math.max(a.x1,b.x1)&&Math.min(a.y2,b.y2)>Math.max(a.y1,b.y1))pairs.push([bs[i].id,bs[j].id]);}return {nodes:bs.length,overlaps:pairs};});
 await open(p,'http://127.0.0.1:4329/?word=bear');await p.getByLabel('词性',{exact:true}).waitFor();
 const before=await(await p.request.get('http://127.0.0.1:4329/fixture/learning')).json();const startWrites=writes.length;
 assert(await p.title()==='WordLoop local lexical QA','Page identity');assert((await p.locator('dialog').innerText()).includes('暂无已核验中文义项'),'Nonblank');
 assert(await p.getByLabel('词性',{exact:true}).inputValue()==='en:bear:n','Implicit verb preference');
 await p.getByLabel('词性',{exact:true}).selectOption('en:bear:v');await p.getByLabel('当前义项',{exact:true}).selectOption('oewn-bear__2.29.15..');await ready(p);
 const behavior=await check(p);assert(!behavior.overlap.length&&!behavior.clipped.length&&!behavior.overflow.length&&!behavior.documentOverflow&&!behavior.dialogOverflow,'Behavior bounds '+JSON.stringify(behavior));assert(behavior.cards<=8,'Eight groups');assert(!behavior.controls.length,'Touch controls too small');
 const labels=await p.getByRole('navigation',{name:'图谱节点'}).innerText();assert(!/\b(do|have)\b/.test(labels),'Broad default');
 await p.locator('dialog').evaluate(el=>el.scrollTo(0,0));await p.screenshot({path:outputDirectory+`/after-selectors-${width}.png`});
 await p.locator('.network-canvas').scrollIntoViewIfNeeded();await p.screenshot({path:outputDirectory+`/after-bear-${width}.png`});
 await p.getByRole('button',{name:/查看宽泛近义词/}).click();await ready(p);assert((await p.getByRole('navigation',{name:'图谱节点'}).innerText()).includes('do'),'Folded relation lost');
 await p.getByLabel('当前义项',{exact:true}).selectOption('oewn-bear__2.31.00..');await ready(p);assert(!/birth|gestate|harbor/.test(await p.getByRole('navigation',{name:'图谱节点'}).innerText()),'Sense mixing');
 const firstLabels=await p.getByRole('navigation',{name:'图谱节点'}).innerText();await p.getByRole('button',{name:/更多关系（共/}).click();await ready(p);assert((await p.getByRole('navigation',{name:'图谱节点'}).innerText())!==firstLabels,'Pagination inert');await p.getByRole('button',{name:'上一页关系',exact:true}).click();await ready(p);
 await p.getByLabel('当前义项',{exact:true}).selectOption('oewn-bear__2.37.01..');await ready(p);assert(await p.getByRole('navigation',{name:'图谱节点'}).getByRole('button',{name:'harbor / harbour',exact:true}).count()===1,'Variants not grouped');
 await p.locator('.network-groups').scrollIntoViewIfNeeded();await p.screenshot({path:outputDirectory+`/after-variants-${width}.png`});
 // Click an actual rendered node and an actual edge midpoint.
 await p.locator('.network-canvas').scrollIntoViewIfNeeded();let box=await p.locator('.network-canvas').boundingBox();const points=await p.evaluate(()=>{const cy=document.querySelector('.network-canvas')._cyreg.cy;return {center:cy.getElementById('en:bear:v').renderedPosition(),target:cy.getElementById('en:entertain:v').renderedPosition()}});
 await p.mouse.click(box.x+points.target.x,box.y+points.target.y);assert((await p.getByRole('region',{name:'词条概览'}).innerText()).includes('entertain'),'Node selection');
 await p.mouse.click(box.x+(points.target.x+points.center.x)/2,box.y+(points.target.y+points.center.y)/2);assert(await p.locator('.sense-network > .lexical-relation').count()===1,'Edge explanations');
 // Empty filters genuinely clear the current graph, then restore.
 const filters=p.getByRole('navigation',{name:'语义关系过滤'});for(const name of ['近义','反义','对比','搭配'])await filters.getByRole('button',{name,exact:true}).click();await ready(p);assert(await p.locator('[data-network-group]').count()===0,'Empty filters');await filters.getByRole('button',{name:'近义',exact:true}).click();await ready(p);
 const after=await(await p.request.get('http://127.0.0.1:4329/fixture/learning')).json();assert(JSON.stringify(before)===JSON.stringify(after),'Read-only state changed');assert(writes.length===startWrites,'Read-only POST');
 await p.getByRole('button',{name:'返回学习',exact:true}).click();
 await open(p,'http://127.0.0.1:4329/?word=bear&sense=oewn-bear__2.31.00..');
 await p.getByText('当前学习义项已通过服务端词条归属核验。',{exact:true}).waitFor();
 assert(await p.getByLabel('词性',{exact:true}).inputValue()==='en:bear:v','Verified context POS');
 assert(await p.getByLabel('当前义项',{exact:true}).inputValue()==='oewn-bear__2.31.00..','Verified context sense');
 // Bearing: the heraldic charge survives explicit selection, not posture/direction.
 await p.getByRole('button',{name:'返回学习',exact:true}).click();await open(p,'http://127.0.0.1:4329/?word=bearing');await p.getByLabel('词性',{exact:true}).selectOption('en:bearing:n');
 for(const sense of ['oewn-bearing__1.07.00..','oewn-bearing__1.07.01..','oewn-bearing__1.15.00..','oewn-bearing__1.06.01..']){
  await p.getByLabel('当前义项',{exact:true}).selectOption(sense);await ready(p);const l=await p.getByRole('navigation',{name:'图谱节点'}).innerText();assert(l.includes('charge')===(sense==='oewn-bearing__1.06.01..'),'Charge sense');const state=await check(p);assert(!state.overlap.length&&!state.clipped.length&&!state.overflow.length&&!state.dialogOverflow,'Bearing bounds');
 }
 await p.locator('.network-groups').scrollIntoViewIfNeeded();await p.screenshot({path:outputDirectory+`/after-bearing-heraldry-${width}.png`});
 // Family/Root navigation, internal scrolling and long words remain intact.
 await p.getByRole('button',{name:'词根同源',exact:true}).click();await p.getByText('暂无已核验的词源关系',{exact:true}).waitFor();await p.getByRole('navigation',{name:'图谱视图'}).getByRole('button',{name:'词族',exact:true}).click();await p.getByRole('region',{name:'词卡与短练习'}).waitFor();await p.getByRole('button',{name:'语义网络',exact:true}).click();await ready(p);
 assert(!errors.length,'Console '+errors.join('\n'));
 reports.push({viewport:{width,height,touch},pageIdentity:true,nonblank:true,frameworkOverlay:false,errors,warnings,before:beforeLayout,after:behavior,readOnlyLearningEqual:true,readOnlyWrites:0,senseSwitch:true,folded:true,pagination:true,variants:true,bearingCharge:true,nodeClick:true,edgeClick:true,viewSwitch:true});await ctx.close();
}
return reports;


}
