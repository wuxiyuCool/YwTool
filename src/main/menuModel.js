/**
 * 菜单结构模型（纯数据，不依赖 electron）
 * ------------------------------------------------------------------
 * 菜单栏与界面共用同一套「域 → 页面」结构，因此这里只维护一份元数据：
 *   - 主进程 menu.js 用它构建原生菜单栏
 *   - 渲染进程 router.js 用它渲染侧边栏（renderer 侧保留自己的一份以支持演示模式）
 * 两者的一致性由 .workbuddy/channel-check.js 静态校验，避免结构漂移。
 */

/** 四大运维域（顺序即菜单与界面中的展示顺序） */
const DOMAINS = [
    { id: 'server', label: '服务器运维' },
    { id: 'database', label: '数据库运维' },
    { id: 'security', label: '安全运维' },
    { id: 'system', label: '系统运维' }
];

/**
 * 页面清单
 * label   菜单 / 侧边栏展示名
 * domain  所属域
 * module  权限判定所用的模块 id（对应 permissions.js 的 MODULES）
 */
const PAGES = [
    { id: 'dashboard', label: '总览', domain: 'server', module: 'dashboard' },
    { id: 'hosts', label: '主机管理', domain: 'server', module: 'hosts' },
    { id: 'containers', label: '容器运维', domain: 'server', module: 'containers' },
    { id: 'tasks', label: '任务执行', domain: 'server', module: 'tasks' },
    { id: 'scripts', label: '脚本管理', domain: 'server', module: 'scripts' },

    { id: 'dbconfig', label: '数据库配置', domain: 'database', module: 'dbconfig' },
    { id: 'sql', label: 'SQL 工作台', domain: 'database', module: 'sqltools' },
    { id: 'etl', label: '数据集成', domain: 'database', module: 'etl' },

    { id: 'netsec', label: '网络安全', domain: 'security', module: 'netsec' },
    { id: 'infosec', label: '信息安全', domain: 'security', module: 'infosec' },

    { id: 'accounts', label: '多系统账号', domain: 'system', module: 'accounts' },
    { id: 'ledger', label: '凭据台账', domain: 'system', module: 'ledger' },
    { id: 'sensitive', label: '敏感词配置', domain: 'system', module: 'rules' },
    { id: 'audit', label: '日志审计', domain: 'system', module: 'audit' },
    { id: 'aiconfig', label: 'AI 配置', domain: 'system', module: 'ai' },
    { id: 'system', label: '系统设置', domain: 'system', module: 'settings' }
];

const DOMAIN_LABEL = DOMAINS.reduce((acc, d) => { acc[d.id] = d.label; return acc; }, {});
const PAGE_LABEL = PAGES.reduce((acc, p) => { acc[p.id] = p.label; return acc; }, {});
const PAGE_MODULE = PAGES.reduce((acc, p) => { acc[p.id] = p.module; return acc; }, {});

const pageDomain = id => (PAGES.find(p => p.id === id) || {}).domain || null;
const domainsOf = () => DOMAINS.map(d => d.id);
const pagesOf = domainId => PAGES.filter(p => p.domain === domainId);
const pageIds = () => PAGES.map(p => p.id);

module.exports = {
    DOMAINS, PAGES, DOMAIN_LABEL, PAGE_LABEL, PAGE_MODULE,
    pageDomain, domainsOf, pagesOf, pageIds
};
