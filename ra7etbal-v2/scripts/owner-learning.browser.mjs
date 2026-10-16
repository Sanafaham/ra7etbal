// Run with the disposable local database from owner-learning.real-db.test.mjs.
// PLAYWRIGHT_MODULE points to a separately installed pinned Playwright package.
import { createServer } from 'vite';
import { writeFileSync, mkdirSync } from 'node:fs';
import { startLocalAdapter } from './fixtures/owner-learning-local.mjs';
const {chromium}=await import(process.env.PLAYWRIGHT_MODULE ?? '@playwright/test');
const adapter=await startLocalAdapter();
const server=await createServer({server:{host:'127.0.0.1',port:5164},define:{
  'import.meta.env.VITE_SUPABASE_URL':JSON.stringify(adapter.url),
  'import.meta.env.VITE_SUPABASE_ANON_KEY':JSON.stringify('isolated-local-anon'),
},plugins:[{name:'local-learning-fixture',configureServer(vite){vite.middlewares.use('/__learning',async(req,res)=>{res.setHeader('Content-Type','text/html');res.end(await vite.transformIndexHtml('/__learning','<html><head><meta name="viewport" content="width=device-width, initial-scale=1" /></head><body><div id="root"></div><script type="module" src="/scripts/fixtures/owner-learning-ui.tsx"></script></body></html>'));});}}]});
await server.listen();
let browser;
const results=[];
try {
  browser=await chromium.launch({headless:true,args:['--no-sandbox']});
  for(const width of [320,390,1280]) {
    const page=await browser.newPage({viewport:{width,height:844}});
    const external=[];
    await page.route('**/*',route=>{const host=new URL(route.request().url()).hostname;if(!['127.0.0.1','localhost'].includes(host)){external.push(host);return route.abort();}return route.continue();});
    await page.goto('http://127.0.0.1:5164/__learning');
    await page.waitForFunction(()=>!!window.learningFixture);
    await page.evaluate(async()=>{await window.learningFixture.reset();await window.learningFixture.teach('Offer three travel options.');});
    await page.getByRole('button',{name:'What Carson remembers',exact:true}).click();
    await page.getByText('Offer three travel options.',{exact:true}).waitFor();
    await page.getByRole('button',{name:'Correct',exact:true}).click();
    await page.getByRole('textbox',{name:'Correct this instruction'}).fill('Offer two travel options.');
    await page.getByRole('button',{name:'Save correction',exact:true}).click();
    await page.getByText('Correction saved for your next conversation.',{exact:true}).waitFor();
    const context=await page.evaluate(()=>window.learningFixture.context());
    if(!context.includes('Offer two')||context.includes('Offer three'))throw Error('Correction context failed');
    await page.getByRole('button',{name:'Correct',exact:true}).click();
    await page.getByRole('textbox').fill('Do not apply this failed write.');
    await fetch(`${adapter.url}/__fixture/fail-insert`);
    await page.getByRole('button',{name:'Save correction',exact:true}).click();
    await page.getByText("Couldn't save that change.",{exact:true}).waitFor();
    if(!(await page.evaluate(()=>window.learningFixture.context())).includes('Offer two'))throw Error('Failed write lost rule');
    await page.getByRole('button',{name:'Cancel',exact:true}).click();
    const overflow=await page.getByRole('dialog').evaluate(el=>el.scrollWidth>el.clientWidth);
    if(overflow)throw Error(`Horizontal overflow at ${width}`);
    mkdirSync('/tmp/464-evidence',{recursive:true});
    await page.screenshot({path:`/tmp/464-evidence/settings-${width}.png`,fullPage:true});
    // Reopen the actual Settings panel after introducing competing versions.
    await page.evaluate(()=>window.learningFixture.createConflict());
    await page.getByRole('button',{name:'Back to Settings',exact:true}).click();
    await page.getByRole('button',{name:'What Carson remembers',exact:true}).click();
    await page.getByText('Offer four travel options.',{exact:true}).waitFor();
    if(await page.getByRole('button',{name:'Resolve conflict',exact:true}).count()!==2)throw Error('Conflict versions hidden');
    await page.getByRole('button',{name:'Resolve conflict',exact:true}).first().click();
    await page.getByRole('textbox').fill('Offer five travel options.');
    await page.getByRole('button',{name:'Save correction',exact:true}).click();
    await page.getByText('Correction saved for your next conversation.',{exact:true}).waitFor();
    await page.getByRole('textbox').waitFor({state:'detached'});
    const resolved=await page.evaluate(()=>window.learningFixture.context());
    if(!resolved.includes('Offer five')||resolved.includes('Offer four')||resolved.includes('Offer six'))throw Error('Conflict not resolved');
    await page.getByRole('button',{name:'Remove instruction',exact:true}).click();
    await page.getByText('Instruction removed.',{exact:true}).waitFor();
    if(await page.evaluate(()=>window.learningFixture.context())!=='')throw Error('Deleted rule returned');
    await page.reload();await page.waitForFunction(()=>!!window.learningFixture);
    await page.getByRole('button',{name:'What Carson remembers',exact:true}).click();
    await page.getByText('No standing instructions saved yet.',{exact:true}).waitFor();
    await page.evaluate(()=>window.learningFixture.teach('Use this trip label: '+ 'X'.repeat(380)));
    await page.getByRole('button',{name:'Back to Settings',exact:true}).click();
    await page.getByRole('button',{name:'What Carson remembers',exact:true}).click();
    await page.getByText(/^Use this trip label:/).waitFor();
    if(await page.getByRole('dialog').evaluate(el=>el.scrollWidth>el.clientWidth))throw Error('Long instruction overflow');
    await page.getByRole('button',{name:'Remove instruction',exact:true}).click();
    await page.getByText('Instruction removed.',{exact:true}).waitFor();
    // The stylesheet may reference external fonts; these are blocked above.
    results.push({width,review:true,correct:true,remove:true,failedWrite:true,conflictResolution:true,longTextWrap:true,reload:true,horizontalOverflow:false,blockedExternalHosts:[...new Set(external)]});
    await page.close();
  }
  writeFileSync('/tmp/464-evidence/browser-results.json',JSON.stringify(results,null,2));
  console.log(JSON.stringify(results));
} finally {await browser?.close();await server.close();await adapter.close();}
