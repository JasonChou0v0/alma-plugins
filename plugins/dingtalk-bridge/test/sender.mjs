/**
 * 验证群聊里能区分发送人。
 *
 * 问题：Alma 的 userMessage 没有"发送者"字段，
 * 不往正文里编发送人信息，模型就分不清群里谁在说话。
 */
import { AlmaSocket } from '../lib/alma-socket.ts';

let pass = 0;
let fail = 0;
const check = (name, cond, extra = '') => {
    console.log(`  ${cond ? '✅' : '❌'} ${name}${extra ? `  ${extra}` : ''}`);
    cond ? pass++ : fail++;
};

console.log('\n[单人消息]');
{
    const out = AlmaSocket.composeUserText('你好', { nick: '张三', staffId: 's123' });
    check('带发言人昵称', out.includes('张三'), JSON.stringify(out));
    check('带发言人 ID', out.includes('s123'));
    check('保留原消息', out.includes('你好'));
    check('单聊不显示群名', !out.includes('群：'));
}

console.log('\n[群聊消息]');
{
    const out = AlmaSocket.composeUserText('帮我看下这个 bug', {
        nick: '李四',
        staffId: 's456',
        chatTitle: '研发群',
    });
    check('带群名', out.includes('群：研发群'), JSON.stringify(out));
    check('带发言人', out.includes('发言人：李四'));
    check('保留原消息', out.includes('帮我看下这个 bug'));
}

console.log('\n[不同发送人可区分]');
{
    const a = AlmaSocket.composeUserText('问题A', { nick: '张三', staffId: 's1', chatTitle: '群' });
    const b = AlmaSocket.composeUserText('问题B', { nick: '李四', staffId: 's2', chatTitle: '群' });
    check('两条消息文本不同', a !== b);
    check('A 含张三不含李四', a.includes('张三') && !a.includes('李四'));
    check('B 含李四不含张三', b.includes('李四') && !b.includes('张三'));
}

console.log('\n[边界情况]');
{
    /* 没昵称时用 ID 兜底 */
    const noNick = AlmaSocket.composeUserText('hi', { staffId: 's789' });
    check('无昵称用 ID 兜底', noNick.includes('s789'), JSON.stringify(noNick));

    /* 没有 sender 信息时原样返回，不污染普通调用 */
    const none = AlmaSocket.composeUserText('hi', undefined);
    check('无 sender 信息原样返回', none === 'hi', JSON.stringify(none));

    const noStaffId = AlmaSocket.composeUserText('hi', { nick: '张三' });
    check('无 staffId 原样返回', noStaffId === 'hi', JSON.stringify(noStaffId));

    /* 昵称为空字符串时用 ID */
    const emptyNick = AlmaSocket.composeUserText('hi', { nick: '  ', staffId: 's999' });
    check('空白昵称用 ID 兜底', emptyNick.includes('s999'), JSON.stringify(emptyNick));
}

console.log('\n[多行消息不被破坏]');
{
    const multi = '第一行\n第二行\n第三行';
    const out = AlmaSocket.composeUserText(multi, { nick: '王五', staffId: 's5' });
    check('多行内容完整保留', out.includes('第一行') && out.includes('第三行'));
    check('前缀只占第一行', out.split('\n')[0].includes('王五'));
}


console.log('\n[群内 @机器人 时命令识别]');
{
    /* 钉钉群里 @机器人，文本会带 "@豆豆" 前缀，必须剥掉才能识别命令 */
    const strip = (t) => t.replace(/@[\u4e00-\u9fa5A-Za-z0-9_\-]+(@\d+)?/g, ' ').replace(/[ \t]+/g, ' ').trim();

    check('@豆豆 /help -> /help', strip('@豆豆 /help') === '/help', JSON.stringify(strip('@豆豆 /help')));
    check('@豆豆@1234567 /help', strip('@豆豆@1234567 /help') === '/help');
    check('@豆豆 /new 标题', strip('@豆豆 /new 我的标题') === '/new 我的标题');
    check('无前缀命令不变', strip('/status') === '/status');
    check('普通消息不受影响', strip('@豆豆 你好') === '你好');
    check('句中 /help 不当命令', strip('前面 /help 后面') === '前面 /help 后面');
}

console.log(`\n结果: ${pass} 通过, ${fail} 失败`);
process.exit(fail === 0 ? 0 : 1);
