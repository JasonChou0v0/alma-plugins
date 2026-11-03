import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { dataPaths } from '../lib/paths.mjs';
import { createLogger } from '../lib/log.ts';
import { DingTalkClient } from '../lib/dingtalk-client.ts';
import { DingTalkBridge } from '../lib/bridge.ts';
import { migrateData } from '../scripts/migrate-data.mjs';

const parent=fileURLToPath(new URL('../tmp',import.meta.url));fs.mkdirSync(parent,{recursive:true});
const base=fs.mkdtempSync(path.join(parent,'data-paths-'));
const realFetch=globalThis.fetch;let checks=0;
const check=(name,fn)=>{fn();checks++;console.log(`✓ ${name}`);};
const logger={info(){},warn(){},error(){}};
try {
  const dataDir=path.join(base,'data with spaces');const paths=dataPaths(dataDir);
  const log=createLogger(logger,dataDir);log.info('runtime-test');
  check('运行日志落入宿主数据目录',()=>{assert.equal(path.dirname(log.filePath()),paths.logs);assert(fs.readFileSync(log.filePath(),'utf8').includes('runtime-test'));});
  globalThis.fetch=async()=>Response.json({errcode:0});
  const client=new DingTalkClient(()=>({}),logger,dataDir);await client.replyWebhook('https://example.invalid','outbound-test');
  const archive=path.join(paths.logs,`dingtalk-payloads-${new Date().toISOString().slice(0,10)}.jsonl`);
  check('出站归档与日志处于同一数据根目录',()=>assert(fs.readFileSync(archive,'utf8').includes('outbound-test')));
  const bridge=new DingTalkBridge({context:{storagePath:dataDir,logger,settings:{}},config:()=>({})});
  bridge.archivePayload({msgId:'inbound-test'},{});
  check('入站归档使用相同目标文件',()=>assert(fs.readFileSync(archive,'utf8').includes('inbound-test')));
  check('日志和归档按私有文件创建',()=>{assert.equal(fs.statSync(log.filePath()).mode&0o777,0o600);assert.equal(fs.statSync(archive).mode&0o777,0o600);});
  bridge.socket.close();

  const old=path.join(base,'old');const dest=path.join(base,'migrated');fs.mkdirSync(old);
  const oldLog=path.join(old,'dingtalk-bridge-2020-01-01.log');const oldRaw=path.join(old,'dingtalk-payloads-2020-01-01.jsonl');
  fs.writeFileSync(oldLog,'history\n');fs.writeFileSync(oldRaw,'{"history":true}\n');fs.writeFileSync(path.join(old,'other-plugin.log'),'untouched');
  const oldSnapshot=path.join(old,'data.json');fs.writeFileSync(oldSnapshot,'{"messages":[]}');
  const result=migrateData({dataDir:dest,legacyLogsDir:old,legacySnapshot:oldSnapshot});
  check('迁移全部指定历史产物',()=>assert.equal(result.migrated,3));
  check('迁移后内容逐字节保留',()=>{assert.equal(fs.readFileSync(path.join(dest,'logs',path.basename(oldLog)),'utf8'),'history\n');assert.equal(fs.readFileSync(path.join(dest,'logs',path.basename(oldRaw)),'utf8'),'{"history":true}\n');});
  check('旧路径仅保留符号链接兼容',()=>{for(const f of [oldLog,oldRaw,oldSnapshot])assert(fs.lstatSync(f).isSymbolicLink());});
  check('不触碰其他插件的日志',()=>{assert(!fs.lstatSync(path.join(old,'other-plugin.log')).isSymbolicLink());assert.equal(fs.readFileSync(path.join(old,'other-plugin.log'),'utf8'),'untouched');});
  const repeat=migrateData({dataDir:dest,legacyLogsDir:old,legacySnapshot:oldSnapshot});
  check('重复迁移幂等',()=>{assert.equal(repeat.migrated,0);assert.equal(repeat.alreadyLinked,3);});
  const conflict=path.join(old,'dingtalk-bridge-2020-01-02.log');fs.writeFileSync(conflict,'source');
  fs.writeFileSync(path.join(dest,'logs',path.basename(conflict)),'different-target');
  assert.throws(()=>migrateData({dataDir:dest,legacyLogsDir:old}));
  check('同名不同内容拒绝覆盖',()=>{assert.equal(fs.readFileSync(conflict,'utf8'),'source');assert.equal(fs.readFileSync(path.join(dest,'logs',path.basename(conflict)),'utf8'),'different-target');});

  const collector=fileURLToPath(new URL('../dashboard/collect.mjs',import.meta.url));
  const sourceSnapshot=path.join(path.dirname(collector),'data.json');
  const original=fs.existsSync(sourceSnapshot)?fs.readFileSync(sourceSnapshot):null;
  execFileSync(process.execPath,[collector],{env:{...process.env,ALMA_DINGTALK_DATA_DIR:dataDir},stdio:'pipe'});
  check('看板HTML和快照统一生成于数据目录',()=>{assert(fs.existsSync(paths.snapshot));assert(fs.existsSync(path.join(paths.dashboard,'index.html')));JSON.parse(fs.readFileSync(paths.snapshot,'utf8'));});
  check('采集器不写源码目录中的data.json',()=>{if(original)assert(fs.readFileSync(sourceSnapshot).equals(original));else assert(!fs.existsSync(sourceSnapshot));});
} finally {globalThis.fetch=realFetch;fs.rmSync(base,{recursive:true,force:true});try{fs.rmdirSync(parent);}catch{}}
console.log(`结果: ${checks} 通过, 0 失败`);
