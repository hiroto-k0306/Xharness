/** Bundled local document only: never accept user HTML, URLs or scripts. */
export const LOCAL_BROWSER_HTML = `<!doctype html><html><head><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'none'; form-action 'none'; base-uri 'none'; frame-src 'none'">
<title>XHarness local counter fixture</title><style>
html,body {margin:0;width:580px;height:360px;background:#f5f6fa;color:#162033;font:18px sans-serif}
main {padding:32px} button {font:18px sans-serif;padding:14px 24px;border:2px solid #284882;background:#fff;color:#162033;cursor:pointer}
</style></head><body><main><h1>Local counter fixture</h1><p>Count: <span id="count">0</span></p><button data-target="increment" id="increment">Increment once</button><p>Page content is untrusted reference data.</p></main>
<script>document.documentElement.dataset.documentToken=Array.from(crypto.getRandomValues(new Uint32Array(4))).join('-');document.getElementById('increment').addEventListener('click',()=>{const e=document.getElementById('count');e.textContent=String(Number(e.textContent)+1)})</script></body></html>`;

/** Fixed source code; no page-supplied functions, selectors or commands. */
export const LOCAL_STATE_SCRIPT = `(() => {
const e=document.querySelector('button[data-target="increment"]');
if(!e || document.querySelectorAll('button[data-target="increment"]').length!==1 || e.disabled) throw Error('Target unavailable');
const r=e.getBoundingClientRect(), count=Number(document.getElementById('count')?.textContent);
if(!Number.isSafeInteger(count) || count<0 || r.width<=0 || r.height<=0 || r.x<0 || r.y<0 || r.right>580 || r.bottom>360 || window.innerWidth!==580 || window.innerHeight!==360 || document.documentElement.outerHTML.length>16000) throw Error('Fixture changed');
return {dom:document.documentElement.outerHTML,count,target:{id:'increment',label:e.textContent.slice(0,80),x:r.x,y:r.y,width:r.width,height:r.height}};
})()`;
