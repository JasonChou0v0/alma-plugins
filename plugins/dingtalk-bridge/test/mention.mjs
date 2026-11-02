/**
 * 验证 @ 提及处理与消息泄漏清洗的边界。
 */
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

/* ---------- @ 提及传参 ---------- */
console.log('\n[@ 提及]');
{
    const noMention = AlmaSocket.composeUserText('你好', { nick: '张三', staffId: 's1' });
    check('无提及时不含 @了', !noMention.includes('@了'), JSON.stringify(noMention));

    const withMention = AlmaSocket.composeUserText('麻烦看下', {
        nick: '张三',
        staffId: 's1',
        chatTitle: '研发群',
        mentions: [{ name: '李四' }],
    });
    check('有提及时带 @了', withMention.includes('@了：李四'), JSON.stringify(withMention));
    check('发言人信息仍在', withMention.includes('发言人：张三'));

    const multi = AlmaSocket.composeUserText('一起看看', {
        nick: '张三',
        staffId: 's1',
        mentions: [{ name: '李四' }, { name: '王五' }],
    });
    check('多人被 @ 全部列出', multi.includes('李四') && multi.includes('王五'), JSON.stringify(multi));

    const emptyMentions = AlmaSocket.composeUserText('hi', { nick: '张三', staffId: 's1', mentions: [] });
    check('空 mentions 不产生 @了', !emptyMentions.includes('@了'));
}

/* ---------- 引用消息场景 ---------- */
console.log('\n[引用消息：sender 兜底]');
{
    /* 有昵称无 ID 时，用 nick 占位仍能组装 */
    const nickOnly = AlmaSocket.composeUserText('这是引用回复', {
        nick: '高喆',
        staffId: 'nick:高喆',
        chatTitle: '研发群',
    });
    check('仅昵称也能组装', nickOnly.includes('高喆'), JSON.stringify(nickOnly));
    check('占位 ID 不出现在正文', !nickOnly.includes('nick:'), JSON.stringify(nickOnly));
}

console.log(`\n结果: ${pass} 通过, ${fail} 失败`);
process.exit(fail === 0 ? 0 : 1);
