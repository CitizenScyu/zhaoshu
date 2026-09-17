import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { createWriteStream } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { connect } from 'node:net';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';

const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const output=path.join(root,'node_modules/.cache/a04-validation/g1');
await mkdir(path.join(output,'temp'),{recursive:true});
process.env.TMP=process.env.TEMP=path.join(output,'temp');
process.env.PLAYWRIGHT_BROWSERS_PATH ||= path.resolve(root,'../playwright-audit/.browsers');
const {chromium}=await import(pathToFileURL(process.env.PLAYWRIGHT_MODULE || path.resolve(root,'../playwright-audit/node_modules/playwright/index.mjs')).href);
const port=3023,url=`http://127.0.0.1:${port}`;
const result={startedAt:new Date().toISOString(),viewports:[{width:1280,height:900},{width:375,height:812}],checks:[],pageErrors:[],unexpectedApi:[],keyboard:[]};
const portOpen=()=>new Promise(resolve=>{
  const socket=connect({host:'127.0.0.1',port});
  const finish=(open)=>{socket.destroy();resolve(open);};
  socket.once('connect',()=>finish(true));socket.once('error',()=>finish(false));socket.setTimeout(500,()=>finish(false));
});
assert.equal(await portOpen(),false,'测试端口已占用');
const env={...process.env,NEXT_TELEMETRY_DISABLED:'1',APP_OWNER_TOKEN:'a04-ui-fixture',AUTH_ACCOUNTS_ENABLED:'false',LLM_API_KEY:'',npm_config_update_notifier:'false'};
delete env.DATABASE_URL;delete env.TEST_DATABASE_URL;
const log=createWriteStream(path.join(output,'next-dev.log'));
const server=spawn(process.execPath,[path.join(path.dirname(process.execPath),'node_modules/npm/bin/npm-cli.js'),'run','dev','--','--hostname','127.0.0.1','--port',String(port)],{cwd:root,env,windowsHide:true,stdio:['ignore','pipe','pipe']});
server.stdout.pipe(log,{end:false});server.stderr.pipe(log,{end:false});
let browser;
let mode='find-only',profileVersion=1,conflictOnce=true;
let currentProfile={seeds:[{title:'测试种子书',kind:'love'}],content:'初始测试画像',updatedAt:'v1'};
let generationStarted,releaseGeneration;
const started=new Promise(resolve=>{generationStarted=resolve;});
const release=new Promise(resolve=>{releaseGeneration=resolve;});
function stats() {
  const allowed=['library','find','shelf'];
  if(['download','owner'].includes(mode))allowed.push('download','shuyuan');
  if(mode==='owner')allowed.push('tokens');
  const states={library:mode==='failure'?'unavailable':'ok',find:'ok',shelf:'ok',download:allowed.includes('download')?'not_ready':'forbidden',shuyuan:allowed.includes('shuyuan')?'ok':'forbidden',tokens:allowed.includes('tokens')?'ok':'forbidden'};
  const zero={prompt:0,completion:0,total:0,cache:0,calls:0,missingUsageCalls:0};
  return {subject:{userId:mode==='owner'?1:2},allowedSections:allowed,sectionStates:states,
    sectionScopes:{library:'shared',find:'personal',shelf:'personal',download:'personal',shuyuan:'shared',tokens:'shared-owner'},
    library:mode==='failure'?null:{total:109,withQuality:90,avgQuality:8.2,charsLabeled:360000,genres:[{name:'仙侠',count:12}]},
    find:{queries:4,recommendations:6},shelf:{statuses:[{name:'want',count:6}]},download:null,
    shuyuan:allowed.includes('shuyuan')?{total:10,active:8,enabled:8,disabled:2,unprobed:5,pending:2,reachable:2,failed:1}:null,
    tokens:allowed.includes('tokens')?{total:zero,last24h:zero,byPhase:['find_recall','find_rerank','profile','feedback'].map(phase=>({phase,...zero}))}:null,
    availability:Object.fromEntries(Object.entries(states).map(([key,state])=>[key,state==='ok'])),
    ...(mode==='failure'?{code:'STATS_PARTIAL',error:'部分统计暂不可用，请稍后重试'}:{})};
}
try {
  const until=Date.now()+60000;
  while(!(await portOpen())){if(Date.now()>until || server.exitCode!==null)throw new Error('开发服务启动失败');await delay(300);}
  browser=await chromium.launch({headless:true});result.browser=browser.version();
  const context=await browser.newContext({viewport:result.viewports[0],locale:'zh-CN',timezoneId:'Asia/Shanghai',reducedMotion:'reduce',serviceWorkers:'block'});
  await context.route('**/*',async route=>{
    const req=route.request(),target=new URL(req.url());
    if(target.origin!==url)return route.abort();
    if(!target.pathname.startsWith('/api/'))return route.continue();
    const json=(value,status=200)=>route.fulfill({status,contentType:'application/json',headers:{'Cache-Control':'private, no-store'},body:JSON.stringify(value)});
    if(target.pathname==='/api/owner')return json({ok:true});
    if(target.pathname==='/api/stats')return json(stats());
    if(target.pathname==='/api/profile') {
      if(req.method()==='GET')return json(currentProfile);
      assert.equal(req.headers()['x-nf-csrf'],'1');
      if(req.method()==='PUT') {
        const body=req.postDataJSON();
        if(conflictOnce){conflictOnce=false;currentProfile={...currentProfile,content:'服务器最新画像',updatedAt:`v${++profileVersion}`};await delay(300);
          return json({code:'PROFILE_CONFLICT',error:'画像有新版本',profile:currentProfile,draft:{seeds:body.seeds,content:body.content}},409);}
        assert.equal(body.updatedAt,currentProfile.updatedAt);
        currentProfile={seeds:body.seeds,content:body.content??currentProfile.content,updatedAt:`v${++profileVersion}`};
        return json({ok:true,...currentProfile});
      }
      if(req.method()==='POST') {
        generationStarted();await release;
        try{return await route.fulfill({status:200,contentType:'text/event-stream',body:`data: ${JSON.stringify({type:'done',seeds:currentProfile.seeds,content:'迟到旧生成稿',updatedAt:'late-old-version'})}\n\n`});}
        catch{return;}
      }
    }
    result.unexpectedApi.push(`${req.method()} ${target.pathname}`);return route.abort();
  });
  const page=await context.newPage();page.on('pageerror',error=>result.pageErrors.push(error.message));
  const press=async(name)=>{const button=page.getByRole('button',{name,exact:true});await button.click({trial:true});await button.focus();await page.keyboard.press('Enter');result.keyboard.push(`聚焦“${name}”并按 Enter`);};
  const check=async(name,fn)=>{await fn();result.checks.push({name,passed:true});console.log(`通过：${name}`);};
  await page.goto(url,{waitUntil:'networkidle',timeout:90000});
  await page.locator('#owner-token').fill('a04-ui-fixture');await page.getByRole('button',{name:'提交口令',exact:true}).click({trial:true});await page.locator('#owner-token').focus();await page.keyboard.press('Tab');await page.keyboard.press('Enter');result.keyboard.push('口令框输入夹具值 → Tab 到提交按钮 → Enter');
  await page.getByRole('button',{name:'退出',exact:true}).waitFor();
  await press('统计');
  await check('仅 find 权限：本人/共享标识清楚，无权限不显示为数据库故障',async()=>{
    await page.getByText('当前账号无权查看下载分区',{exact:true}).waitFor();
    assert.ok((await page.locator('body').innerText()).includes('我的找书次数'));
    assert.ok((await page.locator('body').innerText()).includes('共享书库'));
    assert.ok(!(await page.locator('body').innerText()).includes('统计暂不可用'));
    await page.screenshot({path:path.join(output,'stats-find-only.png'),fullPage:true});
  });
  mode='download';await press('刷新统计');
  await check('有 download 权限：下载明确待开放，书源明确共享',async()=>{
    await page.getByText('下载统计尚未开放',{exact:true}).waitFor();
    assert.ok((await page.locator('body').innerText()).includes('共享书源资料 10 条'));
    assert.ok(!(await page.locator('body').innerText()).includes('统计暂不可用'));
    await page.screenshot({path:path.join(output,'stats-download-pending.png'),fullPage:true});
  });
  mode='owner';await press('刷新统计');
  await check('owner 用量明确为全站共享账目',async()=>{await page.getByText('模型用量为全站共享账目，仅维护者可见。',{exact:true}).waitFor();});
  mode='failure';await press('刷新统计');
  await check('有权分区失败：显示部分不可用，并保留本人计数',async()=>{
    await page.getByRole('status').filter({hasText:'书库统计暂不可用'}).waitFor();
    assert.ok((await page.locator('body').innerText()).includes('累计推荐 6 本次'));
    assert.ok(!(await page.locator('body').innerText()).includes('书源统计暂不可用'));
    await page.screenshot({path:path.join(output,'stats-partial.png'),fullPage:true});
  });
  await press('画像');await press('人工修订');
  const editor=page.locator('textarea[aria-labelledby="profile-content-title"]');
  await editor.fill('我的保留草稿');await press('保存修订');
  await check('画像 409：保留本地草稿，比较后按最新版本重新保存',async()=>{
    await page.getByRole('heading',{name:'画像有新版本',exact:true}).waitFor();
    assert.equal(await editor.inputValue(),'我的保留草稿');
    assert.ok((await page.locator('body').innerText()).includes('服务器最新画像'));
    await page.screenshot({path:path.join(output,'profile-conflict.png'),fullPage:true});
    await press('以当前草稿重新保存');
    await page.getByRole('heading',{name:'画像有新版本',exact:true}).waitFor({state:'hidden'});
    assert.equal(currentProfile.content,'我的保留草稿');
  });
  await press('生成画像');await Promise.race([started,delay(30000).then(()=>{throw new Error('未开始画像生成请求');})]);
  currentProfile={seeds:[{title:'新会话种子',kind:'love'}],content:'新会话的独立画像',updatedAt:'fresh-session-v1'};
  await page.locator('#owner-token').fill('a04-ui-second');await press('提交口令');
  await page.getByText('新会话的独立画像',{exact:true}).waitFor();releaseGeneration();await delay(500);
  await check('更换会话代际后：在途旧生成的迟到响应不能覆盖新画像',async()=>{
    assert.ok(!(await page.locator('body').innerText()).includes('迟到旧生成稿'));
    await page.getByText('新会话的独立画像',{exact:true}).waitFor();
    await page.screenshot({path:path.join(output,'profile-late-response.png'),fullPage:true});
  });
  mode='find-only';await page.setViewportSize(result.viewports[1]);await press('统计');
  await check('375 像素：权限分区可读且没有横向溢出',async()=>{
    await page.getByText('当前账号无权查看下载分区',{exact:true}).waitFor();
    assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth),375);
    await page.screenshot({path:path.join(output,'stats-mobile.png'),fullPage:true});
  });
  assert.deepEqual(result.pageErrors,[]);assert.deepEqual(result.unexpectedApi,[]);result.passed=true;
} catch(error) {result.passed=false;result.error=error.message;process.exitCode=1;}
finally {
  releaseGeneration?.();await browser?.close();
  if(server.pid && server.exitCode===null)result.stopExitCode=spawnSync('taskkill.exe',['/PID',String(server.pid),'/T','/F'],{windowsHide:true,timeout:10000}).status;
  const until=Date.now()+10000;while(await portOpen()){if(Date.now()>until)break;await delay(200);}
  result.serverStopped=!(await portOpen());if(!result.serverStopped){result.passed=false;process.exitCode=1;}
  result.finishedAt=new Date().toISOString();
  server.stdout.unpipe(log);server.stderr.unpipe(log);log.end();
  await writeFile(path.join(output,'result.json'),JSON.stringify(result,null,2)+'\n');
  console.log(JSON.stringify({passed:result.passed,checks:result.checks.length,serverStopped:result.serverStopped}));
}
