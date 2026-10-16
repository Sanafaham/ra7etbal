// Disposable local-only Supabase-shaped adapter. JWTs are verified independently
// by PostgREST before the unmodified migration's real PostgreSQL RLS executes.
import http from 'node:http';
import { createHmac, timingSafeEqual } from 'node:crypto';
export const OWNER_A = '46400000-0000-4000-8000-000000000001';
export const OWNER_B = '46400000-0000-4000-8000-000000000002';
const key = 'carson464-local-test-signing-key-only-0000';
export function tokenFor(id) {
  const encode = value => Buffer.from(JSON.stringify(value)).toString('base64url');
  const input = `${encode({alg:'HS256',typ:'JWT'})}.${encode({sub:id,role:'authenticated',aud:'authenticated',exp:Math.floor(Date.now()/1000)+3600})}`;
  return `${input}.${createHmac('sha256', key).update(input).digest('base64url')}`;
}
export async function startLocalAdapter(port = 4064) {
  const control = { failInsert: false, failDelete: false, barrier: false };
  let waiting = [];
  const server = http.createServer(async (req,res) => {
    res.setHeader('Access-Control-Allow-Origin','*');
    res.setHeader('Access-Control-Allow-Headers','authorization,apikey,content-type,prefer,x-client-info,range,range-unit');
    res.setHeader('Access-Control-Allow-Methods','GET,POST,PATCH,DELETE,OPTIONS');
    if(req.method==='OPTIONS') {res.end();return;}
    const json = (status,body) => {res.writeHead(status,{'Content-Type':'application/json'});res.end(JSON.stringify(body));};
    if(req.url==='/__fixture/session') return json(200,{access_token:tokenFor(OWNER_A),refresh_token:'local-only'});
    if(req.url==='/__fixture/fail-insert') {control.failInsert=true;return json(200,{ok:true});}
    if(req.url==='/auth/v1/user') {
      try {
        const token = req.headers.authorization?.replace(/^Bearer /,'') ?? '';
        const [header,payload,signature] = token.split('.');
        const expected = createHmac('sha256',key).update(`${header}.${payload}`).digest();
        if(!timingSafeEqual(expected,Buffer.from(signature,'base64url'))) throw Error('signature');
        const claims=JSON.parse(Buffer.from(payload,'base64url').toString());
        if(claims.exp<Date.now()/1000 || ![OWNER_A,OWNER_B].includes(claims.sub)) throw Error('identity');
        return json(200,{id:claims.sub,aud:'authenticated',role:'authenticated',email:`${claims.sub}@example.invalid`});
      } catch {return json(401,{message:'Invalid local test JWT'});}
    }
    if(!req.url.startsWith('/rest/v1/')) return json(404,{message:'Local fixture only'});
    const chunks=[];for await(const chunk of req)chunks.push(chunk);
    if(req.method==='POST'&&control.failInsert) {control.failInsert=false;return json(503,{message:'Injected write failure'});}
    if(req.method==='DELETE'&&control.failDelete) {control.failDelete=false;return json(503,{message:'Injected delete failure'});}
    if(req.method==='POST'&&control.barrier) {
      await new Promise(resolve=>{waiting.push(resolve);if(waiting.length===2){control.barrier=false;const release=waiting;waiting=[];release.forEach(fn=>fn());}});
    }
    try {
      const headers={...req.headers};delete headers.host;delete headers.connection;delete headers['content-length'];
      const response=await fetch(`http://127.0.0.1:3064${req.url.slice('/rest/v1'.length)}`,{method:req.method,headers,body:chunks.length?Buffer.concat(chunks):undefined});
      res.writeHead(response.status,Object.fromEntries([...response.headers].filter(([key])=>!['transfer-encoding','connection','content-encoding'].includes(key))));
      res.end(Buffer.from(await response.arrayBuffer()));
    } catch(error){json(503,{message:error.message});}
  });
  await new Promise(resolve=>server.listen(port,'127.0.0.1',resolve));
  return {url:`http://127.0.0.1:${port}`,control,close:()=>new Promise(resolve=>server.close(resolve))};
}
