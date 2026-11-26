// 仅供隔离验收截图：真实项目路由+store，其他宿主接口合成。
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {createProjectStore} from '../project-store.mjs';
import {createProjectHttpAdapter} from '../project-http-adapter.mjs';
import {buildProjectRoutes} from '../project-routes.mjs';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const stateDir=path.join(root,'screenshots','.fixture'); fs.mkdirSync(stateDir,{recursive:true});
const file=path.join(stateDir,process.env.T4D_EMPTY === '1' ? 'empty.json' : 'projects.json');
const store=createProjectStore({file,canAccessSession:()=>true});
if(process.env.T4D_EMPTY !== '1' && !store.list().projects.length){let a=store.create({title:'Agent 王朝：跨会话状态与证据追踪',goal:'可信项目状态',expectedRevision:0}); const id=a.project.projectId; store.link({projectId:id,sessionId:'s1',expectedRevision:store.list().editRevision}); store.addFact({projectId:id,kind:'decision',statement:'采用确定性增量维护项目状态',evidence:[{kind:'manual',by:'user'}],actor:'user',expectedRevision:store.list().editRevision}); store.ingestSummaries({projectId:id,observed:[{sessionId:'s1',versionId:'v1'}],isSaved:()=>true});}
const adapter=createProjectHttpAdapter({file,liveCwdMap:async()=>new Map([['s1',root]]),rulesNow:()=>({rules:{},revision:1}),decideAccess:()=> 'allowed-by-session',isAllowed:r=>r==='allowed-by-session',createStore:createProjectStore});
const routes=buildProjectRoutes({projectHttp:adapter,jsonResponse:(payload,status)=>new Response(JSON.stringify(payload),{status,headers:{'content-type':'application/json'}})});
const now=Date.now();
const server=http.createServer(async(req,res)=>{try{const u=new URL(req.url,'http://127.0.0.1');let data='';for await(const c of req)data+=c; if(u.pathname==='/'||u.pathname==='/standalone.html'){let html=fs.readFileSync(path.join(root,'standalone.html'),'utf8'); if(u.searchParams.get('mode')==='detail') html=html.replace('</body>',`<script>setTimeout(()=>{const b=[...document.querySelectorAll('button')].find(x=>x.textContent.includes('Agent 王朝'));if(b)b.click()},900)</script></body>`); if(u.searchParams.get('mode')==='cards') html=html.replace('</body>',`<script>setTimeout(()=>window.scrollTo(0,document.body.scrollHeight),1200)</script></body>`); if(u.searchParams.get('mode')==='rules') html=html.replace('</body>',`<script>setTimeout(()=>{const b=[...document.querySelectorAll('button')].find(x=>x.textContent==='采集范围');if(b)b.click()},900)</script></body>`);res.writeHead(200,{'content-type':'text/html; charset=utf-8'});res.end(html);return;}
if(u.pathname.startsWith('/api/dsh-wangchao/ui/')){const f=u.pathname.endsWith('mini-react.js')?'mini-react.js':'client.js';res.writeHead(200,{'content-type':'application/javascript'});res.end(fs.readFileSync(path.join(root,f)));return;}
const route=routes.find(x=>x.path===u.pathname&&x.methods.includes(req.method));if(route){const response=await route.fetch({method:req.method,url:req.url,json:async()=>JSON.parse(data)});res.writeHead(response.status,{'content-type':'application/json'});res.end(await response.text());return;}
let body={};if(u.pathname.endsWith('/overview')) body={generatedAt:now,projects:[],totals:{sessions:1},chief:{exists:false},projection:{ok:true,skipped:true,reason:'no-new-versions',added:0,at:now}};else if(u.pathname.endsWith('/sessions'))body={sessions:[]};else if(u.pathname.endsWith('/report-bar'))body={at:now,newSessions:0,uncoveredSeqs:0,tasksAwaitingConfirm:0,censorateViolations:0};else if(u.pathname.endsWith('/role/stream'))body={ok:true,messages:[]};else if(u.pathname.endsWith('/rules'))body={rules:{allowCwds:[root],excludeCwds:[path.join(root,'secret')],allowSessions:[],excludeSessions:[]},config:{allowCwds:[root],excludeCwds:[path.join(root,'secret')],allowSessions:[],excludeSessions:[]},source:'override',explicitFields:['allowCwds'],revision:0,updatedAt:now}; else body={ok:true};res.writeHead(200,{'content-type':'application/json'});res.end(JSON.stringify(body));}catch(e){res.writeHead(500);res.end('error');}});
server.listen(18767,'127.0.0.1',()=>console.log('READY'));
