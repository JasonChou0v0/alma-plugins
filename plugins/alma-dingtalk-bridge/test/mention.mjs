/**
 * 验证 @ 提及处理与消息泄漏清洗的边界。
 */
import { DingTalkBridge } from '../lib/bridge.ts';
import { AlmaSocket } from '../lib/alma-socket.ts';
import { DingTalkClient } from '../lib/dingtalk-client.ts';

let pass = 0;
let fail = 0;
const check = (name, cond, extra = '') => {
    console.log(`  ${cond ? '✅' : '❌'} ${name}${extra ? `  ${extra}` : ''}`);
    cond ? pass++ : fail++;
};

/* ---------- 泄漏清洗：位置无关 ---------- */
console.log('\n[泄漏清洗：任意位置]');
{
    const atStart = `## Response Guidelines
- Be clear and concise
- Use code blocks

真正的回答在这里。`;
    const r1 = DingTalkClient.stripLeakedPrompt(atStart);
    check('开头泄漏被清除', !r1.includes('Response Guidelines'), JSON.stringify(r1));
    check('开头泄漏后正文保留', r1.includes('真正的回答'), JSON.stringify(r1));

    const atEnd = `真正的回答。

## Response Guidelines
- Be clear`;
    const r2 = DingTalkClient.stripLeakedPrompt(atEnd);
    check('结尾泄漏被清除', !r2.includes('Response Guidelines'));
    check('结尾泄漏后正文保留', r2.includes('真正的回答'));

    const inMiddle = `第一段

## Response Guidelines
- Be clear

第二段`;
    const r3 = DingTalkClient.stripLeakedPrompt(inMiddle);
    check('中间泄漏被清除', !r3.includes('Response Guidelines'));
    check('中间泄漏前后正文都保留', r3.includes('第一段') && r3.includes('第二段'), JSON.stringify(r3));

    const onlyLeak = `## Response Guidelines
- Be clear`;
    const r4 = DingTalkClient.stripLeakedPrompt(onlyLeak);
    check('全泄漏时返回空（不退回原文）', r4 === '', JSON.stringify(r4));
}

/* ---------- 泄漏清洗：不误伤 ---------- */
console.log('\n[泄漏清洗：不误伤正常内容]');
{
    const normal = `这是我的回答。
- 要点一
- 要点二`;
    check('普通列表不被误删', DingTalkClient.stripLeakedPrompt(normal) === normal);

    const mentionsWord = '我们团队的 guidelines 是这样的。';
    check('正文提到 guidelines 不被删', DingTalkClient.stripLeakedPrompt(mentionsWord) === mentionsWord);

    const codeBlock = `示例：
\`\`\`js
const a = 1;
\`\`\``;
    check('代码块不被误删', DingTalkClient.stripLeakedPrompt(codeBlock).includes('const a = 1'));
}

/* ---------- 组合：清洗 + markdown 降级 ---------- */
console.log('\n[组合场景]');
{
    const input = `## Response Guidelines
- Be clear

# 真正标题
内容 **加粗**。`;
    const out = DingTalkClient.toDingTalkMarkdown(input);
    check('泄漏清除', !out.includes('Response Guidelines'));
    check('标题降级为 ####', out.includes('#### 真正标题'), JSON.stringify(out));
    check('加粗保留', out.includes('**加粗**'));
}

/* ---------- @ 提及传参（身份现在走 ephemeralContext JSON 元数据） ---------- */
function parseMeta(out) {
    const m = /```json\n([\s\S]*?)\n```/.exec(out ?? '');
    if (!m) return null;
    try {
        return JSON.parse(m[1]);
    } catch {
        return null;
    }
}

console.log('\n[@ 提及]');
{
    const noMention = AlmaSocket.composeEphemeralMetadata({ nick: '张三', staffId: 's1' });
    const metaNo = parseMeta(noMention);
    check('无提及时不带 mentions', metaNo?.mentions === undefined, JSON.stringify(metaNo));

    const withMention = AlmaSocket.composeEphemeralMetadata({
        nick: '张三',
        staffId: 's1',
        chatTitle: '研发群',
        mentions: [{ name: '李四' }],
    });
    const metaM = parseMeta(withMention);
    check('有提及时 mentions 含李四', JSON.stringify(metaM?.mentions) === JSON.stringify(['李四']), JSON.stringify(metaM?.mentions));
    check('发言人信息仍在', metaM?.sender?.displayName === '张三');

    const multi = AlmaSocket.composeEphemeralMetadata({
        nick: '张三',
        staffId: 's1',
        mentions: [{ name: '李四' }, { name: '王五' }],
    });
    const metaMulti = parseMeta(multi);
    check('多人被 @ 全部列出', JSON.stringify(metaMulti?.mentions) === JSON.stringify(['李四', '王五']), JSON.stringify(metaMulti?.mentions));

    const emptyMentions = AlmaSocket.composeEphemeralMetadata({ nick: '张三', staffId: 's1', mentions: [] });
    const metaEmpty = parseMeta(emptyMentions);
    check('空 mentions 不产生 mentions 字段', metaEmpty?.mentions === undefined);
}

/* ---------- 占位 ID 标注为不可信 ---------- */
console.log('\n[占位 ID：不暴露原始前缀]');
{
    /* 有昵称无可信 ID 时，用 nick: 占位；元数据 staffId 置空且标 false，不把 'nick:' 前缀写出去 */
    const nickOnly = AlmaSocket.composeEphemeralMetadata({
        nick: '高喆',
        staffId: 'nick:高喆',
        chatTitle: '研发群',
    });
    const meta = parseMeta(nickOnly);
    check('仅昵称也能组装', meta?.sender?.displayName === '高喆', JSON.stringify(meta));
    check('占位 ID staffId 置空', meta?.sender?.staffId === null);
    check('占位 ID 标为不可信', meta?.sender?.staffIdTrusted === false);
    check('占位前缀不出现在元数据', !nickOnly.includes('nick:'), JSON.stringify(nickOnly).slice(0, 120));
}


/* ---------- 引用消息还原（标注为不可信用户内容、非指令） ---------- */
console.log('\n[引用消息]');
{
    const noQuote = AlmaSocket.composeEphemeralMetadata({ nick: '张三', staffId: 's1' });
    const metaNo = parseMeta(noQuote);
    check('无引用时不带 quoted', metaNo?.quoted === undefined, JSON.stringify(metaNo));

    const withQuote = AlmaSocket.composeEphemeralMetadata({
        nick: '李四',
        staffId: 's2',
        chatTitle: '研发群',
        quoted: { nick: '张三', text: '如何在 Alma 里接钉钉？' },
    });
    const metaQ = parseMeta(withQuote);
    check('引用昵称进 quoted', metaQ?.quoted?.authorDisplayName === '张三', JSON.stringify(metaQ?.quoted));
    check('引用内容完整', metaQ?.quoted?.text === '如何在 Alma 里接钉钉？');
    check('引用 author 标为不可信', metaQ?.quoted?.authorTrusted === false);
    check('引用 text 标为不可信', metaQ?.quoted?.textTrust === false);
    check('引用明确标注非指令', metaQ?.quoted?.isInstruction === false);
    check('元数据带发言人', metaQ?.sender?.displayName === '李四');

    const missQuote = AlmaSocket.composeEphemeralMetadata({
        nick: '李四',
        staffId: 's2',
        quoted: { nick: '', text: '' },
    });
    const metaMiss = parseMeta(missQuote);
    check('缓存未命中时 text 为 null', metaMiss?.quoted?.text === null, JSON.stringify(metaMiss?.quoted));
    check('缓存未命中仍标非指令', metaMiss?.quoted?.isInstruction === false);

    const nullQuote = AlmaSocket.composeEphemeralMetadata({ nick: '王五', staffId: 's3', quoted: null });
    const metaNull = parseMeta(nullQuote);
    check('quoted=null 不产生 quoted 字段', metaNull?.quoted === undefined);
}

/* ---------- 真实入站载荷中的嵌套引用字段 ---------- */
console.log('\n[载荷引用优先与缓存兜底]');
{
    const bridge = Object.create(DingTalkBridge.prototype);
    bridge.msgCache = new Map([
        ['group-a:original', { nick: '缓存作者', text: '旧缓存摘要' }],
        ['group-b:other', { nick: '另一个群', text: '不可跨群读取' }],
    ]);
    bridge.cfg = () => ({ robotName: '豆豆' });
    const payload = {
        conversationId: 'group-a', msgtype: 'text', originalMsgId: 'original',
        text: {
            content: '@豆豆', isReplyMsg: true,
            repliedMsg: { msgId: 'original', senderId: 'quoted-author', msgType: 'text',
                content: { text: '  事件中的完整引用\n第二行  ' } },
        },
    };
    const quote = bridge.resolveQuotedMessage(payload);
    check('嵌套引用正文优先于旧缓存', quote?.text === payload.text.repliedMsg.content.text);
    check('不把引用作者ID猜成昵称', quote?.nick === '');
    check('引用保留原始换行与空格', quote?.text.startsWith('  ') && quote.text.endsWith('  '));
    check('没有 originalMsgId 仍可读取内嵌引用',
        bridge.resolveQuotedMessage({ ...payload, originalMsgId: undefined })?.text === quote.text);
    const withText = text => ({ ...payload, text });
    check('没有内嵌正文时查询同群缓存',
        bridge.resolveQuotedMessage(withText({ content: '问题' }))?.text === '旧缓存摘要');
    check('内嵌正文为空时查询缓存',
        bridge.resolveQuotedMessage(withText({ content: '', repliedMsg: { content: { text: '  ' } } }))?.text === '旧缓存摘要');
    check('正文类型异常不崩溃且回退缓存',
        bridge.resolveQuotedMessage(withText({ content: '', repliedMsg: { content: { text: { malformed: true } } } }))?.text === '旧缓存摘要');
    check('可按 repliedMsg.msgId 查同群缓存',
        bridge.resolveQuotedMessage({ ...payload, originalMsgId: undefined,
            text: { content: '', repliedMsg: { msgId: 'original' } } })?.text === '旧缓存摘要');
    const missing = bridge.resolveQuotedMessage({ conversationId: 'group-a', originalMsgId: 'other' });
    check('缓存缺失不读取其它群的同ID消息', missing?.text === '');
    check('普通消息不虚构引用', bridge.resolveQuotedMessage({ conversationId: 'group-a', text: { content: '你好' } }) === null);
    check('仅 text.isReplyMsg 也保留引用标记',
        bridge.resolveQuotedMessage({ conversationId: 'group-a', text: { content: '', isReplyMsg: true } })?.text === '');
    check('只@机器人且缺少顶层引用ID时仍生成占位正文',
        bridge.extractText({ ...payload, originalMsgId: undefined }).includes('用户引用了一条消息'));
    const meta = parseMeta(AlmaSocket.composeEphemeralMetadata({ nick: '提问者', staffId: 'test-user', quoted: quote }));
    check('实际引用正文送入agent元数据并保持不可信标记',
        meta?.quoted?.text === quote.text && meta.quoted.textTrust === false && meta.quoted.isInstruction === false);
}

console.log(`\n结果: ${pass} 通过, ${fail} 失败`);
process.exit(fail === 0 ? 0 : 1);
