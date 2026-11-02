import assert from 'node:assert/strict';
import { DingTalkBridge } from '../lib/bridge.ts';

let assertions=0, seq=0;
const check=(name,fn)=>{fn();assertions++;console.log(`✓ ${name}`);};
function setup(options={}) {
  const data=new Map(Object.entries({allowedStaffIds:'admin,member',adminStaffIds:'admin',allowedConversationIds:'g1',...options}));
  const config=()=>({clientId:'',clientSecret:'',robotName:'豆豆',mode:'per-chat',logRawPayload:false,
    groupAgentPolicy:'refuse',...Object.fromEntries(['allowedStaffIds','adminStaffIds','allowedConversationIds'].map(k=>[k,(data.get(k)||'').split(',').filter(Boolean)]))});
  const writes=[];
  const context={logger:{info(){},warn(){},error(){}},storage:{local:{get:async()=>null,set:async()=>{}}},
    settings:{get:(key,fallback)=>data.get(key.replace('dingtalkBridge.',''))??fallback,
      update:async(key,value)=>{await new Promise(r=>setImmediate(r));writes.push({key,value});data.set(key.replace('dingtalkBridge.',''),value);}}};
  const bridge=new DingTalkBridge({context,config});
  const replies=[];let submissions=0;
  bridge.dingtalk.replyWebhook=async(_w,text)=>{replies.push(text);return {ok:true};};
  bridge.socket.submit=async()=>{submissions++;throw Error('auth command must not start agent');};
  const send=async(text,options={})=>{
    const payload={msgId:`auth-test-${++seq}`,conversationId:'g1',conversationType:'2',senderStaffId:'admin',
      senderNick:'Admin',chatbotUserId:'bot',msgtype:'text',text:{content:`@豆豆 ${text}`},sessionWebhook:'https://test.invalid',
      atUsers:[{dingtalkId:'bot',name:'豆豆'}],...options};
    await bridge.handleIncoming({data:payload});return replies.at(-1);
  };
  return {bridge,config,data,writes,context,send,replies,get submissions(){return submissions;}};
}
const originalFetch=globalThis.fetch;
globalThis.fetch=()=>{throw Error('real network forbidden');};
try {
  const t=setup();
  await t.send('/allow @新人',{atUsers:[{dingtalkId:'bot',name:'豆豆'},{staffId:'new-user',name:'新人'}]});
  check('结构化@真实staffId进入白名单',()=>assert(t.config().allowedStaffIds.includes('new-user')));
  check('机器人自己不会被授权',()=>assert(!t.config().allowedStaffIds.includes('bot')));
  check('授权命令不调用agent且不启用群工具',()=>{assert.equal(t.submissions,0);assert.equal(t.config().groupAgentPolicy,'refuse');});
  const count=t.writes.length;
  await t.send('/allow user new-user');
  check('重复授权幂等',()=>assert.equal(t.writes.length,count));
  await t.send('/deny @新人',{atUsers:[{dingtalkId:'bot',name:'豆豆'},{staffId:'new-user',name:'新人'}]});
  check('撤销用户立即从白名单移除',()=>assert(!t.config().allowedStaffIds.includes('new-user')));
  const before=t.writes.length;
  const reply=await t.send('/allow @冒名',{atUsers:[{dingtalkId:'bot',name:'豆豆'},{dingtalkId:'opaque-id',name:'冒名'}]});
  check('只有昵称或dingtalkId时拒绝猜staffId',()=>{assert.equal(t.writes.length,before);assert(reply.includes('未提供'));});
  await t.send('/allow user nick:fake');
  check('拒绝显式nick占位ID',()=>assert.equal(t.writes.length,before));
  await t.send('/allow user attacker',{senderStaffId:'member',senderNick:'Admin'});
  check('白名单普通用户冒用管理员昵称无效',()=>assert.equal(t.writes.length,before));
  await t.send('/allow user attacker',{senderStaffId:'outsider'});
  check('未授权用户不能执行授权命令',()=>assert.equal(t.writes.length,before));
  const empty=setup({allowedStaffIds:''});await empty.send('/allow group',{conversationId:'g2'});
  check('管理员也不能绕过空用户白名单自行开通',()=>assert.equal(empty.writes.length,0));
  const group=setup();
  await group.send('/allow user some-user',{conversationId:'g2'});
  check('未开放群不允许用户授权操作',()=>assert.equal(group.writes.length,0));
  await group.send('/allow group',{conversationId:'g2',senderStaffId:'member'});
  check('普通用户不能首次授权群',()=>assert.equal(group.writes.length,0));
  await group.send('/allow group',{conversationId:'g2'});
  check('已授权管理员可首次授权当前群',()=>assert(group.config().allowedConversationIds.includes('g2')));
  await group.send('/allow group g3',{conversationId:'g2'});
  check('群命令不能靠群昵称或任意参数指定别的群',()=>assert(!group.config().allowedConversationIds.includes('g3')));
  await group.send('/deny group',{conversationId:'g2'});
  check('可撤销当前群',()=>assert(!group.config().allowedConversationIds.includes('g2')));
  await group.send('/allow group',{conversationType:'1',conversationId:'dm'});
  check('私聊不能授权当前群',()=>assert(!group.config().allowedConversationIds.includes('dm')));
  await t.send('/allow admin attacker');
  check('聊天命令不能新增管理员',()=>assert.deepEqual(t.config().adminStaffIds,['admin']));
  await t.send('/deny user admin');
  check('群命令不会误锁管理员',()=>assert(t.config().allowedStaffIds.includes('admin')));
  await Promise.all([t.send('/allow user user-a'),t.send('/allow user user-b')]);
  check('并发授权不覆盖彼此',()=>{assert(t.config().allowedStaffIds.includes('user-a'));assert(t.config().allowedStaffIds.includes('user-b'));});
  const list=await t.send('/access');
  check('管理员可查授权列表',()=>{assert(list.includes('user-a'));assert(list.includes('g1'));});
  const deniedList=await t.send('/access',{senderStaffId:'member'});
  check('普通用户不能查询授权列表',()=>assert(!deniedList.includes('user-a')));
  const fail=setup();fail.context.settings.update=async()=>{throw Error('Missing settings:write permission');};
  const failReply=await fail.send('/allow user failed');
  check('持久化失败不会报告成功',()=>{assert(failReply.includes('未成功确认'));assert(!fail.config().allowedStaffIds.includes('failed'));});
  const many=setup();await many.send('/allow @甲 @乙',{atUsers:[{dingtalkId:'bot',name:'豆豆'},{name:'甲',staffId:'A'},{name:'乙',staffId:'B'}]});
  check('一次可授权多个真实提及',()=>{assert(many.config().allowedStaffIds.includes('A'));assert(many.config().allowedStaffIds.includes('B'));});
  const partial=setup();await partial.send('/allow @甲 @乙',{atUsers:[{dingtalkId:'bot',name:'豆豆'},{name:'甲',staffId:'A'},{name:'乙'}]});
  check('混合缺失身份时整次拒绝，无部分误授权',()=>assert.equal(partial.writes.length,0));
} finally { globalThis.fetch=originalFetch; }
console.log(`结果: ${assertions} 通过, 0 失败`);
