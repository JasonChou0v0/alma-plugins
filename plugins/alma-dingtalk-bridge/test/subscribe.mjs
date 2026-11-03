/**
 * 验证 DWClient 的订阅方式：
 * 机器人消息走 CALLBACK 通道，必须用 registerCallbackListener(TOPIC_ROBOT)。
 *
 * 不连真钉钉网关，直接模拟 SDK 内部的 onDownStream → onCallback → emit 流程，
 * 断言两种注册方式的差异。
 */
import { DWClient, TOPIC_ROBOT } from 'dingtalk-stream';

let pass = 0;
let fail = 0;
const check = (name, cond) => {
    console.log(`  ${cond ? '✅' : '❌'} ${name}`);
    cond ? pass++ : fail++;
};

/* 构造一个不会真的联网的 client */
const client = new DWClient({ clientId: 'x', clientSecret: 'y' });

const robotMsg = {
    type: 'CALLBACK',
    headers: { topic: TOPIC_ROBOT, messageId: 'msg-1' },
    data: JSON.stringify({ conversationId: 'cid', senderUnionId: 's1', sessionWebhook: 'http://x' }),
};

/* --- 场景 1：registerAllEventListener（错误用法） --- */
{
    let received = 0;
    const c1 = new DWClient({ clientId: 'x', clientSecret: 'y' });
    c1.registerAllEventListener(() => {
        received += 1;
        return { status: 'SUCCESS' };
    });
    /* 模拟 SDK：CALLBACK 走 onCallback -> emit(topic) */
    c1.onCallback(robotMsg);
    check('registerAllEventListener 收不到 CALLBACK 消息', received === 0);
}

/* --- 场景 2：registerCallbackListener（正确用法） --- */
{
    let received = 0;
    let payload = null;
    const c2 = new DWClient({ clientId: 'x', clientSecret: 'y' });
    c2.registerCallbackListener(TOPIC_ROBOT, (msg) => {
        received += 1;
        payload = msg;
    });
    c2.onCallback(robotMsg);
    check('registerCallbackListener 收到 CALLBACK 消息', received === 1);
    check('收到的载荷带 conversationId', JSON.parse(payload.data).conversationId === 'cid');
}

/* --- 场景 3：确认订阅被登记到 config，握手时才会下发 --- */
{
    const c3 = new DWClient({ clientId: 'x', clientSecret: 'y' });
    c3.registerCallbackListener(TOPIC_ROBOT, () => {});
    const subs = c3.getConfig().subscriptions ?? [];
    const found = subs.find((s) => s.topic === TOPIC_ROBOT && s.type === 'CALLBACK');
    check('订阅已登记为 CALLBACK 类型', Boolean(found));
}

/* --- 场景 4：ACK 格式 --- */
{
    const c4 = new DWClient({ clientId: 'x', clientSecret: 'y' });
    let sent = null;
    c4.socket = { send: (raw) => { sent = JSON.parse(raw); } };
    c4.socketCallBackResponse('msg-1', { status: 'SUCCESS' });
    check('ACK 含 code=200', sent?.code === 200);
    check('ACK 回传同样的 messageId', sent?.headers?.messageId === 'msg-1');
}

console.log(`\n结果: ${pass} 通过, ${fail} 失败`);
process.exit(fail === 0 ? 0 : 1);
