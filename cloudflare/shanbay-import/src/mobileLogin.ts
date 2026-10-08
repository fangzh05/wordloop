// The fragment keeps the short-lived Live View credential out of HTTP requests.
export function mobileLoginUrl(origin: string, liveUrl: string): string {
  const live = new URL(liveUrl);
  if (live.origin !== "https://live.browser.run" || !live.searchParams.get("wss")) throw new Error("Invalid Live View URL");
  return `${origin}/login#${encodeURIComponent(liveUrl)}`;
}

export const mobileLoginHtml = `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1,interactive-widget=resizes-content">
<meta name="referrer" content="no-referrer"><title>扇贝登录 · WordLoop</title>
<style>
*{box-sizing:border-box}body{margin:0;font:16px system-ui,sans-serif;background:#f7f8fa;color:#18221b}
main{height:100dvh;display:flex;flex-direction:column}header,form{padding:12px}p{margin:0 0 8px;font-size:14px}
iframe{border:0;width:100%;flex:1;min-height:180px;background:white}label{display:block;margin-bottom:6px}
.row{display:flex;gap:8px}input{min-width:0;flex:1;padding:12px;font-size:16px;border:1px solid #c8d0ca;border-radius:8px}
button{padding:10px 14px;font-size:16px;border:0;border-radius:8px;background:#246548;color:white}
button:disabled{opacity:.5}form{padding-bottom:max(12px,env(safe-area-inset-bottom))}#status{margin-top:8px}
</style></head><body><main>
<header><strong>扇贝登录</strong><p>先点下方扇贝页面中的账号、密码或验证码框，再用底部输入框输入并发送。完成登录后返回 WordLoop。</p></header>
<iframe id="view" title="扇贝远程登录页面" referrerpolicy="no-referrer"></iframe>
<form id="keyboard" autocomplete="off"><label for="text">输入到已选中的扇贝输入框</label>
<div class="row"><input id="text" type="password" autocomplete="off" autocapitalize="off" spellcheck="false" aria-label="输入账号、密码或验证码"><button id="send" disabled>发送</button><button id="erase" type="button" disabled aria-label="删除远端输入框的最后一个字符">退格</button></div>
<p id="status" role="status">正在连接…</p></form></main>
<script>
const view=document.getElementById('view'),form=document.getElementById('keyboard'),input=document.getElementById('text');
const send=document.getElementById('send'),erase=document.getElementById('erase'),status=document.getElementById('status');
let socket,nextId=0,busy=false;const pending=new Map();
function buttons(){send.disabled=erase.disabled=busy||!socket||socket.readyState!==WebSocket.OPEN;input.readOnly=busy;}
function command(method,params){return new Promise((resolve,reject)=>{
 const id=++nextId,timer=setTimeout(()=>{pending.delete(id);reject(new Error('timeout'));},10000);
 pending.set(id,{resolve,reject,timer});socket.send(JSON.stringify({id,method,params}));
});}
async function perform(work){if(busy||!socket||socket.readyState!==WebSocket.OPEN)return;
 busy=true;buttons();try{await work();status.textContent='已发送。可选择下一个扇贝输入框继续输入。';}
 catch{status.textContent='未确认发送成功，请检查扇贝输入框后再操作。';}finally{busy=false;buttons();}}
form.addEventListener('submit',event=>{event.preventDefault();const text=input.value;if(!text)return;
 void perform(async()=>{await command('Input.insertText',{text});input.value='';});});
erase.addEventListener('click',()=>void perform(async()=>{
 await command('Input.dispatchKeyEvent',{type:'keyDown',key:'Backspace',code:'Backspace',windowsVirtualKeyCode:8});
 await command('Input.dispatchKeyEvent',{type:'keyUp',key:'Backspace',code:'Backspace',windowsVirtualKeyCode:8});
}));
window.addEventListener('pagehide',()=>{input.value='';socket?.close();});
try{
 const live=new URL(decodeURIComponent(location.hash.slice(1)));history.replaceState(null,'',location.pathname);
 if(live.origin!=='https://live.browser.run'||live.pathname!=='/ui/view')throw new Error('invalid');
 const raw=live.searchParams.get('wss');if(!raw)throw new Error('invalid');
 const ws=new URL(raw.startsWith('wss://')?raw:'wss://'+raw);
 if(ws.protocol!=='wss:'||ws.hostname!=='live.browser.run'||ws.port||!ws.pathname.includes('/page/'))throw new Error('invalid');
 view.src=live.href;socket=new WebSocket(ws.href);
 socket.addEventListener('open',()=>{buttons();status.textContent='已连接。先点扇贝输入框，再点这里输入。';});
 socket.addEventListener('message',event=>{let data;try{data=JSON.parse(event.data);}catch{return;}
 const item=pending.get(data.id);if(!item)return;pending.delete(data.id);clearTimeout(item.timer);
 if(data.error)item.reject(new Error('remote'));else item.resolve();});
 socket.addEventListener('close',()=>{input.value='';buttons();for(const item of pending.values()){clearTimeout(item.timer);item.reject(new Error('closed'));}pending.clear();status.textContent='连接已断开，请返回 WordLoop 重新打开扇贝登录。';});
 socket.addEventListener('error',()=>{status.textContent='连接失败，请返回 WordLoop 重新打开扇贝登录。';});
}catch{status.textContent='登录链接无效，请从 WordLoop 打开扇贝登录。';}
</script></body></html>`;

export function mobileLoginResponse(): Response {
  return new Response(mobileLoginHtml, { headers: {
    "content-type": "text/html; charset=utf-8", "cache-control": "no-store",
    "referrer-policy": "no-referrer", "x-content-type-options": "nosniff",
    "content-security-policy": "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; frame-src https://live.browser.run; connect-src wss://live.browser.run; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
  } });
}
