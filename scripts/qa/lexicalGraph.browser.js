async (page, outputDirectory) => {
  const results=[];
  const assert=(value,message)=>{if(!value)throw Error(message);};
  const browser=page.context().browser();
  for(const [width,height,touch] of [[390,844,true],[820,1180,true],[1440,1000,false]]){
    const ctx=await browser.newContext({viewport:{width,height},hasTouch:touch,isMobile:touch,deviceScaleFactor:1});
    const p=await ctx.newPage(),errors=[],warnings=[],requests=[];
    p.on('pageerror',e=>errors.push(e.message));p.on('console',m=>{if(m.type()==='error')errors.push(m.text());if(m.type()==='warning')warnings.push(m.text());});p.on('request',r=>requests.push(r.url()));
    await p.goto('http://127.0.0.1:4329/?word=circle');
    assert(await p.title()==='WordLoop local lexical QA','Wrong page');
    assert(!requests.some(u=>u.includes('/family.js')||u.includes('/lexical/graph')),'Eager graph load');
    const before=await (await p.request.get('http://127.0.0.1:4329/fixture/evidence')).json();
    await p.getByRole('button',{name:'词族',exact:true}).click();
    await p.getByRole('button',{name:'词根同源',exact:true}).click();
    await p.getByRole('navigation',{name:'图谱节点'}).getByRole('button',{name:'circulate',exact:true}).waitFor();
    await p.waitForFunction(()=>!!document.querySelector('.family-canvas')?._cyreg?.cy);
    const initial=await p.evaluate(()=>{const cy=document.querySelector('.family-canvas')._cyreg.cy;window.__qa_cy=cy;return {nodes:cy.nodes().length,zoom:cy.zoom(),kinds:cy.nodes().map(n=>n.classes())};});
    assert(initial.nodes<=24,'Initial node cap');assert(initial.kinds.some(k=>k.includes('etymon')),'Historical type style missing');
    await p.screenshot({path:`${outputDirectory}/root-${width}.png`});
    const light=await p.locator('.family-canvas').evaluate(el=>getComputedStyle(el).backgroundColor);
    await p.evaluate(()=>document.documentElement.dataset.theme='dark');
    await p.screenshot({path:`${outputDirectory}/root-dark-${width}.png`});
    assert(await p.locator('.family-canvas').evaluate(el=>getComputedStyle(el).backgroundColor)!==light,'Dark theme not applied');
    await p.evaluate(()=>document.documentElement.dataset.theme='light');
    await p.getByRole('navigation',{name:'图谱节点'}).getByRole('button',{name:'circulus · Latin',exact:true}).click();
    assert(await p.getByRole('region',{name:'词条与关系详情'}).getByText('历史词源 · Latin',{exact:true}).isVisible(),'Etymon card missing');
    assert(await p.getByRole('region',{name:'词条与关系详情'}).getByRole('button',{name:'加入未来候选'}).count()===0,'Etymon candidate control');
    await p.getByRole('button',{name:'展开一跳',exact:true}).click();
    await p.getByRole('navigation',{name:'图谱节点'}).getByRole('button',{name:'cercle · Old French',exact:true}).waitFor();
    assert(await p.getByRole('navigation',{name:'图谱节点'}).getByRole('button').count()<=40,'Visible cap');
    await p.getByRole('navigation',{name:'图谱节点'}).getByRole('button',{name:'circulate',exact:true}).click();
    await p.getByRole('button',{name:'加入未来候选',exact:true}).click();
    await p.getByRole('status').filter({hasText:'尚未创建学习卡'}).waitFor();
    // Touch events use rendered Cytoscape coordinates; no fake application events.
    await p.locator('.family-canvas').scrollIntoViewIfNeeded();
    const box=await p.locator('.family-canvas').boundingBox();
    const pos=await p.evaluate(()=>document.querySelector('.family-canvas')._cyreg.cy.getElementById('en:circular:a').renderedPosition());
    if(touch){
      const cdp=await ctx.newCDPSession(p);
      await cdp.send('Input.dispatchTouchEvent',{type:'touchStart',touchPoints:[{x:box.x+pos.x,y:box.y+pos.y,id:0}]});
      await cdp.send('Input.dispatchTouchEvent',{type:'touchEnd',touchPoints:[]});
      assert(await p.getByRole('region',{name:'词条与关系详情'}).getByRole('heading',{name:/circular/}).count()===1,'Touch select');
      const z0=await p.evaluate(()=>document.querySelector('.family-canvas')._cyreg.cy.zoom());
      const cx=box.x+box.width/2,cy=box.y+box.height/2;
      await cdp.send('Input.dispatchTouchEvent',{type:'touchStart',touchPoints:[{x:cx-25,y:cy,id:0},{x:cx+25,y:cy,id:1}]});
      for(const delta of [35,50,65])await cdp.send('Input.dispatchTouchEvent',{type:'touchMove',touchPoints:[{x:cx-delta,y:cy,id:0},{x:cx+delta,y:cy,id:1}]});
      await cdp.send('Input.dispatchTouchEvent',{type:'touchEnd',touchPoints:[]});
      const z1=await p.evaluate(()=>document.querySelector('.family-canvas')._cyreg.cy.zoom());assert(z1>z0,'Pinch did not zoom');
      await cdp.send('Input.dispatchTouchEvent',{type:'touchStart',touchPoints:[{x:cx-65,y:cy,id:0},{x:cx+65,y:cy,id:1}]});
      for(const delta of [50,35,25])await cdp.send('Input.dispatchTouchEvent',{type:'touchMove',touchPoints:[{x:cx-delta,y:cy,id:0},{x:cx+delta,y:cy,id:1}]});
      await cdp.send('Input.dispatchTouchEvent',{type:'touchEnd',touchPoints:[]});
      await p.getByRole('button',{name:'适合窗口',exact:true}).click();
      await p.locator('.family-canvas').scrollIntoViewIfNeeded();
      // Drag a modern node with touch and preserve its manual position.
      const point=await p.evaluate(()=>document.querySelector('.family-canvas')._cyreg.cy.getElementById('en:circular:a').renderedPosition());
      const original=await p.evaluate(()=>document.querySelector('.family-canvas')._cyreg.cy.getElementById('en:circular:a').position());
      await cdp.send('Input.dispatchTouchEvent',{type:'touchStart',touchPoints:[{x:box.x+point.x,y:box.y+point.y,id:0}]});
      for(const delta of [10,20,30])await cdp.send('Input.dispatchTouchEvent',{type:'touchMove',touchPoints:[{x:box.x+point.x+delta,y:box.y+point.y+delta,id:0}]});
      await cdp.send('Input.dispatchTouchEvent',{type:'touchEnd',touchPoints:[]});
      const moved=await p.evaluate(()=>document.querySelector('.family-canvas')._cyreg.cy.getElementById('en:circular:a').position());
      assert(Math.abs(original.x-moved.x)>1,'Touch drag did not move '+JSON.stringify({box,point,original,moved}));
      const savesBeforeHold=requests.filter(u=>u.includes('/family/candidates')).length;
      const held=await p.evaluate(()=>document.querySelector('.family-canvas')._cyreg.cy.getElementById('en:circular:a').renderedPosition());
      await cdp.send('Input.dispatchTouchEvent',{type:'touchStart',touchPoints:[{x:box.x+held.x,y:box.y+held.y,id:0}]});
      await p.waitForTimeout(650);
      await cdp.send('Input.dispatchTouchEvent',{type:'touchEnd',touchPoints:[]});
      await p.getByRole('status').filter({hasText:'尚未创建学习卡'}).waitFor();
      assert(requests.filter(u=>u.includes('/family/candidates')).length===savesBeforeHold+1,'Long press did not save candidate');
      // Double tap uses the same gesture path as a user, then asserts new center.
      for(let i=0;i<2;i++){
        await cdp.send('Input.dispatchTouchEvent',{type:'touchStart',touchPoints:[{x:box.x+held.x,y:box.y+held.y,id:0}]});
        await cdp.send('Input.dispatchTouchEvent',{type:'touchEnd',touchPoints:[]});
        await p.waitForTimeout(70);
      }
      await p.waitForFunction(()=>document.querySelector('.family-canvas')?._cyreg?.cy.nodes('.center').id()==='en:circular:a');
      await cdp.detach();
    }
    await p.evaluate(()=>window.__qa_cy=document.querySelector('.family-canvas')._cyreg.cy);
    await p.getByRole('button',{name:'语义网络',exact:true}).click();
    await p.getByRole('navigation',{name:'语义关系过滤'}).waitFor();
    assert(await p.evaluate(()=>window.__qa_cy.destroyed()),'Root engine not released on view switch');
    await p.getByRole('button',{name:'返回学习',exact:true}).click();
    assert(await p.locator('dialog').count()===0,'Dialog not closed');
    await p.goto('http://127.0.0.1:4329/?word=persuade');
    await p.getByRole('button',{name:'词族',exact:true}).click();
    await p.getByRole('navigation',{name:'词族节点'}).getByRole('button',{name:'persuasion',exact:true}).waitFor();
    await p.getByRole('button',{name:'语义网络',exact:true}).click();
    await p.getByLabel('当前义项',{exact:true}).selectOption('wikt:persuade:v:agree');
    await p.getByRole('navigation',{name:'图谱节点'}).getByRole('button',{name:'convince',exact:true}).waitFor();
    await p.getByLabel('当前义项',{exact:true}).selectOption('oewn-persuade__2.32.00..');
    await p.getByRole('navigation',{name:'图谱节点'}).getByRole('button',{name:'persuade someone to do something',exact:true}).click();
    assert(await p.getByRole('region',{name:'词条概览'}).count()===0,'Pattern candidate control');
    await p.screenshot({path:`${outputDirectory}/network-${width}.png`});
    await p.getByRole('navigation',{name:'语义关系过滤'}).getByRole('button',{name:'近义',exact:true}).click();
    await p.waitForFunction(()=>!document.querySelector('[aria-label="图谱节点"]')?.textContent.includes('convince'));
    for(const name of ['反义','对比','搭配'])await p.getByRole('navigation',{name:'语义关系过滤'}).getByRole('button',{name,exact:true}).click();
    await p.getByText('暂无所选类型的已核验关系。',{exact:true}).waitFor();
    await p.getByRole('button',{name:'词族',exact:true}).last().click();
    await p.getByRole('navigation',{name:'词族节点'}).getByRole('button',{name:'persuasive',exact:true}).waitFor();
    assert(await p.getByRole('button',{name:'学习这个词族 · 约 2 分钟'}).isEnabled(),'Family micro-session disabled');
    const overflow=await p.evaluate(()=>document.documentElement.scrollWidth>innerWidth||document.querySelector('dialog').scrollWidth>document.querySelector('dialog').clientWidth+1);
    assert(!overflow,'Horizontal overflow');
    await p.keyboard.press('Escape');assert(await p.locator('dialog').count()===0,'Escape did not close');
    await p.waitForFunction(()=>document.activeElement?.textContent==='词族');
    const after=await (await p.request.get('http://127.0.0.1:4329/fixture/evidence')).json();
    assert(before.cards===after.cards&&before.reviews===after.reviews&&JSON.stringify(before.frozen)===JSON.stringify(after.frozen),'Learning state changed');
    assert(errors.length===0,'Browser errors: '+errors.join('\n'));
    results.push({width,height,touch,initialNodes:initial.nodes,overflow,errors,warnings,importedLexemes:after.lexemes,importedSenseRelations:after.sense_relations,cards:after.cards,fsrsLogs:after.reviews});
    await ctx.close();
  }
  return results;
}
