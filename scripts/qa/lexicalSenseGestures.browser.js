// Chromium CDP touch emulation; physical iOS Safari is a separate acceptance step.
async (page) => {
const browser=page.context().browser(),reports=[];
for(const [width,height] of [[390,844],[820,1180],[1440,1000]]){
const ctx=await browser.newContext({viewport:{width,height},hasTouch:true,isMobile:true});const p=await ctx.newPage();await p.goto('http://127.0.0.1:4329/?word=bear');await p.getByRole('button',{name:'词族',exact:true}).click();await p.getByRole('button',{name:'语义网络',exact:true}).click();await p.getByLabel('词性',{exact:true}).selectOption('en:bear:v');await p.getByLabel('当前义项',{exact:true}).selectOption('oewn-bear__2.31.00..');await p.waitForFunction(()=>document.querySelector('.network-canvas')?._cyreg?.cy?.nodes().length>1);
await p.locator('.network-canvas').scrollIntoViewIfNeeded();const cdp=await ctx.newCDPSession(p);const box=await p.locator('.network-canvas').boundingBox(),cx=box.x+box.width/2,cy=box.y+box.height/2;const z0=await p.evaluate(()=>document.querySelector('.network-canvas')._cyreg.cy.zoom());
await cdp.send('Input.dispatchTouchEvent',{type:'touchStart',touchPoints:[{x:cx-25,y:cy,id:0},{x:cx+25,y:cy,id:1}]});for(const delta of [35,50,65])await cdp.send('Input.dispatchTouchEvent',{type:'touchMove',touchPoints:[{x:cx-delta,y:cy,id:0},{x:cx+delta,y:cy,id:1}]});await cdp.send('Input.dispatchTouchEvent',{type:'touchEnd',touchPoints:[]});const z1=await p.evaluate(()=>document.querySelector('.network-canvas')._cyreg.cy.zoom());if(z1<=z0)throw Error('Pinch failed');await p.getByRole('button',{name:'适合窗口',exact:true}).click();
await p.locator('.network-canvas').scrollIntoViewIfNeeded();const pos=await p.evaluate(()=>document.querySelector('.network-canvas')._cyreg.cy.getElementById('en:abide:v').renderedPosition());const bounds=await p.locator('.network-canvas').boundingBox();
await cdp.send('Input.dispatchTouchEvent',{type:'touchStart',touchPoints:[{x:bounds.x+pos.x,y:bounds.y+pos.y,id:0}]});await cdp.send('Input.dispatchTouchEvent',{type:'touchMove',touchPoints:[{x:bounds.x+pos.x+20,y:bounds.y+pos.y+10,id:0}]});await cdp.send('Input.dispatchTouchEvent',{type:'touchEnd',touchPoints:[]});const moved=await p.evaluate(()=>document.querySelector('.network-canvas')._cyreg.cy.getElementById('en:abide:v').renderedPosition());if(moved.x<=pos.x+5)throw Error('Drag failed');
// Actual two taps trigger double-click recentering.
for(let i=0;i<2;i++){await cdp.send('Input.dispatchTouchEvent',{type:'touchStart',touchPoints:[{x:bounds.x+moved.x,y:bounds.y+moved.y,id:0}]});await cdp.send('Input.dispatchTouchEvent',{type:'touchEnd',touchPoints:[]});}
await p.waitForFunction(()=>document.querySelector('[aria-label="词性"]')?.value==='en:abide:v');
const selected=await p.getByLabel('当前义项',{exact:true}).inputValue();if(selected!=='oewn-abide__2.31.00..')throw Error('Target sense not preserved '+selected);
// Long press explicitly adds a future candidate but never changes learning state.
await p.waitForFunction(()=>document.querySelector('.network-canvas')?._cyreg?.cy?.nodes().length>1);await p.locator('.network-canvas').scrollIntoViewIfNeeded();const stateBefore=await(await p.request.get('http://127.0.0.1:4329/fixture/learning')).json();const bb=await p.locator('.network-canvas').boundingBox();const n=await p.evaluate(()=>{const cy=document.querySelector('.network-canvas')._cyreg.cy;return cy.nodes().filter(n=>n.id()!== 'en:abide:v')[0].renderedPosition()});
await cdp.send('Input.dispatchTouchEvent',{type:'touchStart',touchPoints:[{x:bb.x+n.x,y:bb.y+n.y,id:0}]});await p.waitForTimeout(700);await cdp.send('Input.dispatchTouchEvent',{type:'touchEnd',touchPoints:[]});await p.getByRole('status').filter({hasText:'已加入未来候选'}).waitFor();const stateAfter=await(await p.request.get('http://127.0.0.1:4329/fixture/learning')).json();if(JSON.stringify(stateBefore)!==JSON.stringify(stateAfter))throw Error('Candidate changed learning');
reports.push({width,height,pinch:true,drag:true,doubleTap:true,targetSense:selected,longPress:true,candidateLearningStateEqual:true});await ctx.close();
}
return reports;

}
