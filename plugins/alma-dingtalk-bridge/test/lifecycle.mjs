import assert from 'node:assert/strict';
import { createContext } from './harness.mjs';
import { DingTalkBridge } from '../lib/bridge.ts';
import { AlmaSocket } from '../lib/alma-socket.ts';
import { activate } from '../main.ts';
const tick=()=>new Promise(r=>setImmediate(r));
const timers=new Map();
const originals={setTimeout,clearTimeout,setInterval,clearInterval,start:DingTalkBridge.prototype.start,stop:DingTalkBridge.prototype.stop};
let starts=0, stops=0, onChange, activation, checks=0;
const check=(n,f)=>{f();checks++;console.log('✓ '+n);};
try {
  // Only the connection attempt is simulated; activation lifecycle / backoff is production code.
  globalThis.setTimeout=(fn,ms)=>{const id={unref(){}};timers.set(id,{fn,ms});return id;};
  globalThis.clearTimeout=id=>timers.delete(id);
  globalThis.setInterval=()=>({});globalThis.clearInterval=()=>{};
  DingTalkBridge.prototype.start=async function(){starts++;if(starts===1)throw Error('connection failed');this.running=true;};
  DingTalkBridge.prototype.stop=async function(){stops++;this.running=false;};
  const {context}=createContext({quiet:true});
  context.settings.onDidChange=fn=>{onChange=fn;return{dispose(){onChange=undefined;}};};
  activation=await activate(context);await tick();
  const retry=[...timers].find(([,v])=>v.ms===2000);
  check('首次启动失败安排2秒重试',()=>{assert.equal(starts,1);assert(retry);});
  timers.delete(retry[0]);retry[1].fn();await tick();
  check('重试实际执行且无重复连接',()=>{assert.equal(starts,2);assert.equal(stops,2);});
  onChange({key:'dingtalkBridge.clientId'});onChange({key:'dingtalkBridge.robotCode'});
  const changes=[...timers].filter(([,v])=>v.ms===300);
  check('多项凭据变化合并为一次重连',()=>assert.equal(changes.length,1));
  timers.delete(changes[0][0]);changes[0][1].fn();await tick();
  check('凭据变更执行停连再启动',()=>{assert.equal(starts,3);assert.equal(stops,3);});
  onChange({key:'dingtalkBridge.clientSecretSecretKey'});
  await activation.dispose();activation=undefined;
  check('卸载取消重试与配置回调',()=>{assert.equal(timers.size,0);assert.equal(onChange,undefined);});
  const sent=[];const callbacks={onTextDelta(){},onToolAnnounce(){},onToolOutput(){},onComplete(){},onError(){}};
  const sock=new AlmaSocket(()=> 'ws://test.invalid', {info(){},warn(){},error(){}},callbacks);
  class FakeWS {
    readyState=1;listeners=new Map();
    on(name,cb){this.listeners.set(name,cb);if(name==='open')queueMicrotask(()=>cb());}
    send(raw){sent.push(JSON.parse(raw));} close(){}
  }
  sock.Ctor=FakeWS;sock.pendingStops.add('old-thread');
  await sock.connect();await tick();
  check('重连时优先补发待取消请求',()=>assert.deepEqual(sent[0],{type:'stop_generation',data:{threadId:'old-thread'}}));
  sock.close();sock.resume();await sock.connect();await tick();
  check('显式restart后WS可以重新连接',()=>assert(sock.isOpen()));
  const turn={threadId:'deadline',text:'',tools:[],announcedTools:[],startedAt:Date.now(),lastActivity:Date.now(),finished:false};
  await sock.submit(turn,'test:model','test',{staffId:'a'});
  const deadline=[...timers].find(([,v])=>v.ms===15*60_000);
  check('每轮登记15分钟绝对期限',()=>assert(deadline));
  deadline[1].fn();
  check('绝对期限触发后停止并隔离',()=>{assert(sock.quarantined.has('deadline'));assert(sent.some(x=>x.type==='stop_generation'&&x.data.threadId==='deadline'));assert(!sock.isRunning('deadline'));});
  sock.close();
} finally {
  if(activation)await activation.dispose();
  Object.assign(globalThis,{setTimeout:originals.setTimeout,clearTimeout:originals.clearTimeout,setInterval:originals.setInterval,clearInterval:originals.clearInterval});
  DingTalkBridge.prototype.start=originals.start;DingTalkBridge.prototype.stop=originals.stop;
}
console.log(`结果: ${checks} 通过, 0 失败`);
