// 御书房接线自检：确认独立窗口默认入口、视图切换、消息投递与报告条接口都接上了。
// 纯源码检查，不连宿主；行为层由后端纯函数测试覆盖。
import { readFileSync } from 'node:fs';
import { createChecker } from './fake-host.mjs';

const CLIENT = new URL('../client.js', import.meta.url);
const HTML = new URL('../standalone.html', import.meta.url);
const INDEX = new URL('../index.mjs', import.meta.url);
const { cases, run: check } = createChecker();

const client = readFileSync(CLIENT, 'utf8');
const html = readFileSync(HTML, 'utf8');
const index = readFileSync(INDEX, 'utf8');

check('单一视图御书房：独立窗口与主窗口都进御书房', () => {
  if (!/__wcDefaultView\s*=\s*'war'/.test(html)) throw new Error('standalone.html 未设置默认御书房标志');
  if (/standaloneMode\s*===\s*'war'/.test(client)) throw new Error('client.js 仍保留双视图分支，应已收敛为单一御书房视图');
});

check('御书房四区齐全：顶栏报告条 / 三栏 / 底部卡片', () => {
  for (const cls of ['wc-report', 'wc-grid', 'wc-col', 'wc-bottom']) {
    if (!client.includes(cls)) throw new Error('缺少布局类：' + cls);
  }
  if (!/WAR_CSS/.test(client) || !/CSS \+ '\\n' \+ WAR_CSS/.test(client)) throw new Error('御书房样式未注入 DOM');
});

check('中栏发消息 + 主窗展开按钮都接线', () => {
  if (!client.includes("'/api/dsh-wangchao/role/message'")) throw new Error('未接消息投递接口');
  if (!client.includes("'/api/dsh-wangchao/role/open-in-host'")) throw new Error('未接主窗展开接口');
  if (!/发送给首辅/.test(client) || !/在主窗展开/.test(client)) throw new Error('缺少按钮');
  if (!/简化对话视图/.test(client)) throw new Error('未如实标注能力边界');
});

check('采集台账抽屉已接入御书房', () => {
  if (!/采集台账/.test(client) || !/采集台账/.test(client) || !/buildSessionsSection\(\(ss && ss\.sessions\)/.test(client)) throw new Error('缺少采集台账卡片或抽屉');
  if (!/sidebar\.panellist/.test(client)) throw new Error('侧栏注册被移除');
});

check('报告条接口按已授权会话聚合', () => {
  if (!index.includes("path: '/api/dsh-wangchao/report-bar'")) throw new Error('未注册报告条接口');
  if (!/visibleRows\(\)/.test(index)) throw new Error('报告条未走实时判权');
});

export function run() {
  return { name: '04-warroom', cases };
}
