/**
 * 验证钉钉消息格式转换：
 * - Markdown 降级到钉钉支持的子集
 * - 剥掉模型复述的系统提示
 */
import { DingTalkClient } from '../lib/dingtalk-client.ts';

let pass = 0;
let fail = 0;
const check = (name, cond, extra = '') => {
    console.log(`  ${cond ? '✅' : '❌'} ${name}${extra ? `  ${extra}` : ''}`);
    cond ? pass++ : fail++;
};
const show = (s) => JSON.stringify(s.slice(0, 100));

/* ---------------- 标题降级 ---------------- */
console.log('\n[标题降级]');
{
    const input = '# 一级标题\n## 二级标题\n### 三级标题\n正文';
    const out = DingTalkClient.toDingTalkMarkdown(input);
    check('# 变成 ####', out.includes('#### 一级标题'), show(out));
    check('## 变成 ####', out.includes('#### 二级标题'));
    check('### 变成 ####', out.includes('#### 三级标题'));
    check('正文保留', out.includes('正文'));
}

/* ---------------- 分隔线 ---------------- */
console.log('\n[分隔线]');
{
    const out = DingTalkClient.toDingTalkMarkdown('上文\n\n---\n\n下文');
    check('--- 被移除', !out.includes('---'), show(out));
    check('上下文都在', out.includes('上文') && out.includes('下文'));
    const out2 = DingTalkClient.toDingTalkMarkdown('A\n***\nB');
    check('*** 被移除', !out2.includes('***'));
    const out3 = DingTalkClient.toDingTalkMarkdown('A\n___\nB');
    check('___ 被移除', !out3.includes('___'));
}

/* ---------------- 任务列表 ---------------- */
console.log('\n[任务列表]');
{
    const out = DingTalkClient.toDingTalkMarkdown('- [ ] 待办\n- [x] 已完成');
    check('- [ ] 变普通列表', out.includes('- 待办') && !out.includes('[ ]'), show(out));
    check('- [x] 变普通列表', out.includes('- 已完成') && !out.includes('[x]'));
}

/* ---------------- HTML 剥离 ---------------- */
console.log('\n[HTML 剥离]');
{
    const out = DingTalkClient.toDingTalkMarkdown('文本<br/>换行<div>块</div>');
    check('<br/> 被剥掉', !out.includes('<br'), show(out));
    check('<div> 被剥掉', !out.includes('<div'));
    check('文字保留', out.includes('文本') && out.includes('换行'));
}

/* ---------------- 应当保留的语法 ---------------- */
console.log('\n[保留钉钉支持的语法]');
{
    const input = '**粗体** 和 *斜体*\n- 列表项\n1. 有序项\n> 引用\n`行内代码`\n```js\nconst a = 1;\n```\n[链接](https://a.com)';
    const out = DingTalkClient.toDingTalkMarkdown(input);
    check('粗体保留', out.includes('**粗体**'));
    check('列表保留', out.includes('- 列表项'));
    check('有序列表保留', out.includes('1. 有序项'));
    check('引用保留', out.includes('> 引用'));
    check('行内代码保留', out.includes('`行内代码`'));
    check('代码块保留', out.includes('```js'));
    check('链接保留', out.includes('[链接](https://a.com)'));
}

/* ---------------- 剥掉泄漏的提示词 ---------------- */
console.log('\n[剥掉泄漏的系统提示]');
{
    const real = `Alma 原生渠道里就 飞书 / Telegram / Discord / 微信 这四个。
像这种 markdown 格式发到钉钉还能优化。

## Response Guidelines
- Be clear and concise in your explanations
- Use code blocks with appropriate language tags
- Structure your response with headings`;

    const out = DingTalkClient.stripLeakedPrompt(real);
    check('保留真正的回答', out.includes('飞书'), show(out));
    check('移除 Response Guidelines', !out.includes('Response Guidelines'), show(out));
    check('移除泄漏的条目', !out.includes('Be clear and concise'));
    check('没有尾部空段落', out.trim() === out);
}

{
    const zh = '正常回答。\n\n## 回复要求\n- 要简洁';
    const out = DingTalkClient.stripLeakedPrompt(zh);
    check('中文标题也被剥离', !out.includes('回复要求'), show(out));
    check('中文回答保留', out.includes('正常回答'));
}

{
    /* 没有泄漏时原样返回 */
    const clean = '这是一段正常回答，包含 **粗体**。\n- 列表';
    const out = DingTalkClient.stripLeakedPrompt(clean);
    check('无泄漏时原样返回', out === clean);
}

{
    /* 只有泄漏内容时应清空，由调用方兜底提示语；绝不能把泄漏原文发出去 */
    const only = '## Response Guidelines\n- Be clear';
    const out = DingTalkClient.stripLeakedPrompt(only);
    check('全泄漏时返回空（不退回原文）', out === '', show(out));
}

/* ---------------- 标题推导 ---------------- */
console.log('\n[消息标题推导]');
{
    check('从首行取标题', DingTalkClient.deriveTitle('这是首行\n第二行') === '这是首行');
    check('剥掉 # 号', DingTalkClient.deriveTitle('## 标题文字\n内容') === '标题文字');
    check('剥掉 ** 号', DingTalkClient.deriveTitle('**加粗标题**\n内容') === '加粗标题');
    check('空文本有兜底', DingTalkClient.deriveTitle('\n\n') === 'Alma');
    check('标题不超过 30 字', DingTalkClient.deriveTitle('A'.repeat(100)).length <= 30);
}

/* ---------------- 端到端组合 ---------------- */
console.log('\n[组合：先剥泄漏再降级]');
{
    const input = `回答正文，**重点**在这里。

# 大标题
内容

---
## Response Guidelines
- Be clear`;
    const out = DingTalkClient.toDingTalkMarkdown(input);
    check('保留 **重点**', out.includes('**重点**'), show(out));
    check('# 标题降级', out.includes('#### 大标题'));
    check('分隔线移除', !out.includes('---'));
    check('泄漏内容移除', !out.includes('Response Guidelines'));
}

console.log(`\n结果: ${pass} 通过, ${fail} 失败`);
process.exit(fail === 0 ? 0 : 1);
