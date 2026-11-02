#!/usr/bin/env node
// CLI 不读取插件配置或密钥，也不绕过插件的收件人授权。
console.error('独立 CLI 发信已停用。请使用 Alma 的 dingtalk_notify 工具，由插件安全存储读取凭据并校验白名单。');
process.exitCode = 1;
