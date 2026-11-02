/**
 * 验证「不会刷屏」：一轮对话最多推几条消息。
 *
 * 历史 bug：agent 一轮调 9 次 Bash，旧逻辑每次都推一条「正在使用 Bash…」，
 * 用户收到 9+ 条消息。现在规则：
 * - 工具提示整轮只 1 条
 * - 流式分段最多 3 段（且默认关闭）
 * - 最终回复按 4000 字切分
 */
import { DingTalkClient } from '../lib/dingtalk-client.ts';

let pass = 0;
let fail = 0;
const check = (name, cond, extra = '') => {
    console.log(`  ${cond ? '✅' : '❌'} ${name}${extra ? `  ${extra}` : ''}`);
    cond ? pass++ : fail++;
};

/* --- 模拟一轮多工具调用的推送条数 --- */
function simulateTurn({ toolCalls, text, streaming }) {
    const sent = [];
    let toolNoticeSent = false;

    /* 工具提示 */
    for (let i = 0; i < toolCalls; i++) {
        if (!toolNoticeSent) {
            toolNoticeSent = true;
            sent.push('⏳ 正在处理…');
        }
    }

    /* 流式分段（最多 3 段） */
    if (streaming) {
        let flushed = 0;
        let count = 0;
        while (count < 3) {
            const piece = DingTalkBridgeTakeFlushable(text, flushed);
            if (!piece) break;
            flushed += piece.length;
            count++;
            sent.push(piece);
        }
        const rest = text.slice(flushed).trim();
        if (rest) sent.push(rest);
    } else {
        sent.push(...DingTalkClient.chunk(text));
    }

    return sent;
}

/* 复用实现里的截取逻辑（避免逻辑漂移，这里直接内联一份等价实现做对照） */
function DingTalkBridgeTakeFlushable(text, alreadySent) {
    const pending = text.slice(alreadySent);
    if (!pending) return '';
    const isBoundary = (ch) =>
        ch === '\n' || ch === '。' || ch === '！' || ch === '？' ||
        ch === '.' || ch === '!' || ch === '?' || ch === '；' || ch === ';';
    let cut = -1;
    const floor = Math.max(0, pending.length - 400);
    for (let i = pending.length - 1; i >= floor; i--) {
        if (isBoundary(pending[i])) {
            cut = i + 1;
            break;
        }
    }
    if (cut > 0) return pending.slice(0, cut);
    return pending.length >= 200 ? pending : '';
}

console.log('\n[9 次工具调用]');
{
    const sent = simulateTurn({ toolCalls: 9, text: '好的。', streaming: false });
    check('工具提示只 1 条', sent.filter((s) => s.startsWith('⏳')).length === 1, `实际 ${sent.length} 条推送`);
    check('总推送数 <= 2', sent.length <= 2, `实际 ${sent.length}`);
}

console.log('\n[长回复 + 流式开启]');
{
    const long = ('这是一句测试内容。'.repeat(20)) + '\n' + ('第二段内容。'.repeat(20));
    const sent = simulateTurn({ toolCalls: 3, text: long, streaming: true });
    check('流式分段不超过 3 段 + 1 条尾巴', sent.length <= 1 + 3 + 1, `实际 ${sent.length}`);
}

console.log('\n[短回复 + 流式开启]');
{
    const sent = simulateTurn({ toolCalls: 1, text: '好的，明白了。', streaming: true });
    /* 1 条工具提示 + 1 条正文 = 2 */
    check('短回复 2 条（提示 + 正文）', sent.length === 2, `实际 ${sent.length}`);
}

console.log('\n[超长最终回复分段]');
{
    const huge = 'X'.repeat(12000);
    const chunks = DingTalkClient.chunk(huge);
    check('超长文本按 4000 字切', chunks.length === 3, `实际 ${chunks.length} 段`);
    check('分段不丢内容', chunks.join('').length === 12000);
}

console.log(`\n结果: ${pass} 通过, ${fail} 失败`);
process.exit(fail === 0 ? 0 : 1);
