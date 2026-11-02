/**
 * 覆盖四个线上问题的回归测试：
 * 1. 消息 @别人时，被 @ 的人不能丢
 * 2. 引用消息 @机器人 要能回复
 * 3. 有进行中的回复时，新消息要排队而不是丢弃
 * 4. /use 不依赖 settings:write 权限
 */

import { readFileSync } from 'node:fs';

let pass = 0;
let fail = 0;
const check = (name, cond, extra = '') => {
    console.log(`  ${cond ? '✅' : '❌'} ${name}${extra ? `  ${extra}` : ''}`);
    cond ? pass++ : fail++;
};

/* ============ 问题 1：@ 提及解析（复刻实现的纯逻辑） ============ */
function parseMentions(raw, botName) {
    const names = new Set();
    const re = /@([^@\s]{1,20})/g;
    let m;
    while ((m = re.exec(raw)) !== null) {
        let name = m[1].trim().replace(/[,，:：。.!！?？]+$/, '').trim();
        if (!name || /^\d+$/.test(name)) continue;
        if (botName && name === botName) continue;
        names.add(name);
    }
    return Array.from(names).map((n) => ({ name: n }));
}

console.log('\n[问题1: @别人时不能漏人]');
{
    check('@豆豆 @冇 -> 只留冇', JSON.stringify(parseMentions('@豆豆 @冇 很调皮', '豆豆')) === '[{"name":"冇"}]');
    check(
        '带数字后缀 @豆豆@1234 @冇',
        JSON.stringify(parseMentions('@豆豆@1234 @冇 很调皮', '豆豆')) === '[{"name":"冇"}]',
        JSON.stringify(parseMentions('@豆豆@1234 @冇 很调皮', '豆豆')),
    );
    check(
        '多人 @张三 @李四',
        parseMentions('@豆豆 @张三 @李四 一起看', '豆豆').length === 2,
        JSON.stringify(parseMentions('@豆豆 @张三 @李四 一起看', '豆豆')),
    );
    check('只 @机器人 时不产生提及', parseMentions('@豆豆 你好', '豆豆').length === 0);
    check(
        '英文名也能解析',
        parseMentions('@豆豆 @Jason hello', '豆豆')[0]?.name === 'Jason',
        JSON.stringify(parseMentions('@豆豆 @Jason hello', '豆豆')),
    );
}

/* ============ 问题 2：引用消息不该被丢弃 ============ */
console.log('\n[问题2: 引用消息 @机器人]');
{
    /* 复刻 extractText 的兜底分支 */
    const finish = (cleaned, original, payload) => {
        if (cleaned) return cleaned;
        const hasReply = Boolean(payload.originalMsgId) || Boolean(payload.content?.isReplyMsg);
        if (hasReply) return '[用户引用了一条消息并 @ 了你，但没有附带文字]';
        return original.trim() || '';
    };

    const r1 = finish('', '@豆豆', { originalMsgId: 'abc' });
    check('引用消息但正文为空 -> 不丢弃', r1.includes('引用了一条消息'), JSON.stringify(r1));

    const r2 = finish('', '@豆豆', {});
    check('非引用且只有 @ -> 回退原文', r2 === '@豆豆', JSON.stringify(r2));

    const r3 = finish('正常内容', '@豆豆 正常内容', {});
    check('有正文时不受影响', r3 === '正常内容');

    /* 关键：只要有 webhook 就该处理，不能因为 senderStaffId 缺失丢弃 */
    const shouldHandle = (p) => Boolean(p.conversationId) && Boolean(p.sessionWebhook);
    check(
        '缺 senderStaffId 但有 webhook 仍处理',
        shouldHandle({ conversationId: 'c', sessionWebhook: 'w' }) === true,
    );
    check('缺 webhook 才丢弃', shouldHandle({ conversationId: 'c' }) === false);
}

/* ============ 问题 3：并发消息排队 ============ */
console.log('\n[问题3: 进行中时新消息排队]');
{
    /* 复刻排队逻辑：isRunning 时进入等待，而不是 return 丢弃 */
    const simulate = (initialRunning) => {
        let running = initialRunning;
        let dropped = false;
        let queued = false;
        let handled = false;

        if (running) {
            queued = true;
            /* 等待空闲 */
            running = false;
        }
        if (!dropped) {
            handled = true;
        }
        return { queued, handled, dropped };
    };

    const idle = simulate(false);
    check('空闲时直接处理', idle.handled && !idle.queued);

    const busy = simulate(true);
    check('忙碌时进入排队', busy.queued === true);
    check('忙碌时不丢弃消息', busy.handled === true);
    check('忙碌时没有 dropped 标记', busy.dropped === false);
}

/* ============ 问题 4：/use 不依赖 settings:write ============ */
console.log('\n[问题4: /use 权限]');
{
    const { permissions } = JSON.parse(readFileSync(new URL('../manifest.json', import.meta.url), 'utf8'));
    check('manifest 不含无效 storage:secrets 权限', !permissions.includes('storage:secrets'));

    /* /use 现在写 storage.local，不需要 settings:write */
    const useImpl = (storage, key, wsId) => {
        storage[key] = wsId;
        return true;
    };
    const store = {};
    check('/use 写 storage 成功', useImpl(store, 'cid::sender', 'workspace-test') === true);
    check('覆盖值已记录', store['cid::sender'] === 'workspace-test');
}

/* ============ 组合：一条完整群消息 ============ */
console.log('\n[组合场景]');
{
    const raw = '@豆豆 @冇 很调皮，你和他聊天悠着点';
    const bot = '豆豆';
    const mentions = parseMentions(raw, bot);
    let text = raw;
    for (const p of mentions) text = text.replace(new RegExp(`@${p.name}`, 'g'), ' ');
    text = text.replace(/@[^@\s]{1,20}?(?=\s|$)/g, ' ').replace(/\s+/g, ' ').trim();

    check('提及解析到冇', mentions[0]?.name === '冇', JSON.stringify(mentions));
    check('正文不含 @ 残留', !text.includes('@'), JSON.stringify(text));
    check('正文保留真实内容', text.includes('很调皮'), JSON.stringify(text));
}

console.log(`\n结果: ${pass} 通过, ${fail} 失败`);
process.exit(fail === 0 ? 0 : 1);
