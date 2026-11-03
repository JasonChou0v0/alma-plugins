import assert from 'node:assert/strict';
import { AlmaSocket } from '../../src/alma-socket.ts';
import { DingTalkBridge } from '../../src/bridge.ts';
import { DingTalkClient } from '../../src/dingtalk-client.ts';
import { loadAlmaImage, MAX_IMAGE_BYTES } from '../../src/media.ts';

let checks=0;
const check=(name,fn)=>{fn();checks++;console.log(`✓ ${name}`);};
const attachment={type:'file',url:'http://localhost:23001/api/gallery/cache/test.png',mediaType:'image/png',filename:'test.png'};
const png=new Uint8Array([137,80,78,71,13,10,26,10,1,2,3]);
const logger={info(){},warn(){},error(){}};
const originalFetch=globalThis.fetch;
try {
  const turn={threadId:'t',chatId:'c',senderId:'owner',conversationType:'2',webhook:'https://test.invalid',text:'图片已发送',tools:[],announcedTools:[],finished:false};
  const socket=new AlmaSocket(()=>'',logger,{onTextDelta(){},onToolAnnounce(){},onToolOutput(){},onComplete(){},onError(){}});
  socket.turns.set('t',turn);
  const event=(type,data)=>socket.dispatch({type,data:{threadId:'t',...data}});
  event('message_added',{message:{id:'user',role:'user',parts:[attachment]}});
  event('message_delta',{deltas:[{type:'part_add',messageId:'old-assistant',part:attachment}]});
  check('不采集用户附件或旧回合附件',()=>assert.equal(turn.attachments,undefined));
  event('message_added',{message:{id:'assistant',role:'assistant',parts:[]}});
  event('message_delta',{deltas:[{type:'part_add',messageId:'assistant',part:attachment}]});
  event('message_updated',{message:{id:'assistant',role:'assistant',parts:[attachment]}});
  check('附件增量和快照去重',()=>assert.equal(turn.attachments.length,1));
  event('message_delta',{threadId:'other',deltas:[{type:'part_add',messageId:'assistant',part:{...attachment,url:attachment.url+'2'}}]});
  check('不会跨线程收集附件',()=>assert.equal(turn.attachments.length,1));
  for(let i=0;i<6;i++)event('message_delta',{deltas:[{type:'part_add',messageId:'assistant',part:{...attachment,url:attachment.url.replace('test',`test${i}`)}}]});
  check('图片数量上限及超额标记',()=>{assert.equal(turn.attachments.length,4);assert.equal(turn.attachmentOverflow,true);});
  let reads=0;
  globalThis.fetch=async()=>{reads++;return new Response(png,{headers:{'content-type':'image/png'}});};
  const image=await loadAlmaImage(attachment,23001);
  check('实际图库附件读为正确图片字节',()=>assert.deepEqual(image.bytes,png));
  for(const url of ['https://evil.invalid/a.png','http://localhost:23001/api/settings','file:///etc/passwd','http://localhost:23001/api/gallery/cache/test.png?token=x','http://localhost:1234/api/gallery/cache/test.png']){
    const before=reads;await assert.rejects(loadAlmaImage({...attachment,url},23001));
    check('非法来源在网络请求前被拒绝',()=>assert.equal(reads,before));
  }
  await assert.rejects(loadAlmaImage({...attachment,mediaType:'application/pdf'},23001));
  check('非图片附件明确拒绝',()=>assert.equal(reads,1));
  globalThis.fetch=async()=>new Response('not an image');
  await assert.rejects(loadAlmaImage(attachment,23001));checks++;
  globalThis.fetch=async()=>new Response(png,{headers:{'content-length':String(MAX_IMAGE_BYTES+1)}});
  await assert.rejects(loadAlmaImage(attachment,23001));checks++;
  globalThis.fetch=async()=>new Response(new ReadableStream({start(c){c.enqueue(new Uint8Array(MAX_IMAGE_BYTES));c.enqueue(png);c.close();}}));
  await assert.rejects(loadAlmaImage(attachment,23001));checks++;
  const client=new DingTalkClient(()=>({clientId:'test',clientSecret:'test',robotCode:'test-bot'}),logger);
  const calls=[];
  globalThis.fetch=async(url,init)=>{
    calls.push({url:String(url),init});
    if(String(url).endsWith('/accessToken'))return Response.json({accessToken:'test-token',expireIn:7200});
    if(String(url).includes('/media/upload'))return Response.json({errcode:0,media_id:'test-media'});
    return Response.json({processQueryKey:'test-receipt'});
  };
  const sent=await client.sendImage({conversationId:'c'},image,()=>true);
  check('先上传再通过群图片模板发送',()=>{
    assert.equal(sent.ok,true);assert(calls[1].init.body instanceof FormData);
    const body=JSON.parse(calls[2].init.body);assert.equal(body.msgKey,'sampleImageMsg');
    assert.equal(body.openConversationId,'c');assert.deepEqual(JSON.parse(body.msgParam),{photoURL:'test-media'});
  });
  const privateResult=await client.sendImage({staffId:'owner'},image,()=>true);
  check('私聊只路由到原senderUnionId',()=>{
    assert(privateResult.ok);const c=calls.at(-1);assert(c.url.endsWith('/oToMessages/batchSend'));
    assert.deepEqual(JSON.parse(c.init.body).userIds,['owner']);
  });
  let allowed=true;let sendCalls=0;
  globalThis.fetch=async()=>{allowed=false;sendCalls++;return Response.json({errcode:0,media_id:'test-media'});};
  const revoked=await client.sendImage({conversationId:'c'},image,()=>allowed);
  check('上传后撤销授权时不发送',()=>{assert(!revoked.ok);assert.equal(sendCalls,1);});
  globalThis.fetch=async(url)=>String(url).includes('/media/upload')?Response.json({errcode:40004}):Promise.reject(Error('unexpected send'));
  check('HTTP200业务上传错误不能报成功',()=>{});
  assert.equal((await client.sendImage({conversationId:'c'},image,()=>true)).ok,false);
  globalThis.fetch=async(url)=>String(url).includes('/media/upload')?Response.json({errcode:0,media_id:'test-media'}):Response.json({});
  assert.equal((await client.sendImage({conversationId:'c'},image,()=>true)).ok,false);
  check('缺少发送回执不算成功',()=>{});
  globalThis.fetch=async()=>{throw Error('url contains secret test-token');};
  const failure=await client.sendImage({conversationId:'c'},image,()=>true);
  check('网络异常不泄漏令牌',()=>{assert(!failure.ok);assert(!failure.error.includes('test-token'));});

  let unionCalls=[];let unionAllowed=true;
  globalThis.fetch=async(url,init)=>{
    unionCalls.push({url:String(url),body:JSON.parse(init.body)});
    if(String(url).includes('/getbyunionid'))return Response.json({errcode:0,result:{userid:'transport-only-id'}});
    return Response.json({processQueryKey:'sent'});
  };
  const unionSent=await client.sendToUnionUser('authorized-union','hello',()=>unionAllowed);
  check('通知按UnionID鉴权，再将其转换为独立投递地址',()=>{
    assert(unionSent.ok);assert.deepEqual(unionCalls[0].body,{unionid:'authorized-union'});
    assert.deepEqual(unionCalls[1].body.userIds,['transport-only-id']);
  });
  unionCalls=[];unionAllowed=false;
  const noUnion=await client.sendToUnionUser('unauthorized','hello',()=>unionAllowed);
  check('未授权UnionID不触发转换或发信',()=>{assert(!noUnion.ok);assert.equal(unionCalls.length,0);});
  unionAllowed=true;let converted=0;
  globalThis.fetch=async()=>{converted++;unionAllowed=false;return Response.json({errcode:0,result:{userid:'transport-only-id'}});};
  const revokeUnion=await client.sendToUnionUser('authorized-union','hello',()=>unionAllowed);
  check('地址解析后撤销UnionID也不能发信',()=>{assert(!revokeUnion.ok);assert.equal(converted,1);});
  let failures=0;globalThis.fetch=async()=>{failures++;return Response.json({errcode:60121});};
  const crossOrg=await client.sendToUnionUser('external-union','hello',()=>true);
  check('跨组织无法解析投递地址时不误用UnionID发送',()=>{assert(!crossOrg.ok);assert.equal(failures,1);});

  const cfg={allowedUnionIds:['owner'],allowedConversationIds:['c'],groupAgentPolicy:'fullTools',almaApiPort:23001};
  const b=new DingTalkBridge({config:()=>cfg,context:{logger,settings:{},storage:{local:{}}}});
  const output=[];
  b.dingtalk.replyWebhook=async(_w,text)=>{output.push(text);return {ok:true};};
  b.dingtalk.sendImage=async(target)=>{assert.deepEqual(target,{conversationId:'c'});return {ok:false,error:'钉钉图片上传失败'};};
  globalThis.fetch=async()=>new Response(png);
  const failedTurn={...turn,attachments:[attachment],attachmentOverflow:false,finished:true};
  await b.finalizeTurn(failedTurn);
  check('图片失败时最终消息不再声称图片已发送',()=>{
    assert(!output.join('').includes('图片已发送'));assert(output.join('').includes('未全部发送成功'));
  });
  output.length=0;b.dingtalk.sendImage=async()=>({ok:true});
  await b.finalizeTurn({...failedTurn,text:'落日图片已生成',flushedChars:0,streamed:false,flushInFlight:undefined});
  check('仅成功回执后追加发送结果',()=>assert(output.join('').includes('1 张图片已获钉钉发送成功回执')));
  cfg.allowedUnionIds=[];let uploads=0;b.dingtalk.sendImage=async()=>{uploads++;return {ok:true};};
  const blocked=await b.sendTurnImages(failedTurn);
  check('回合结束时重新鉴权，不绕过白名单',()=>{assert(blocked.failed);assert.equal(uploads,0);});
  b.socket.close();socket.close();
} finally {globalThis.fetch=originalFetch;}
console.log(`结果: ${checks} 通过, 0 失败`);
