/**
 * 前端路由 · 侧边栏导航 · 应用菜单栏联动
 *
 * 结构：
 *   1. 域（domain）：服务器运维 / 数据库运维 / 系统运维
 *      —— 通过顶部「文件」菜单切换
 *   2. 页面（page）：域内的功能页面
 *      —— 左侧菜单（当前域）+ 顶部「视图」菜单（全域平铺直达）
 *   3. 权限：页面需同时满足「所属模块可见」与「用户能力」才展示 / 可进入
 *      菜单栏同样按此裁剪：不可见的域与页面在菜单中置灰而非可点击
 *
 * 菜单数据流：
 *   主进程 menu:model 下发域 / 页面结构 → 本文件渲染侧边栏
 *   本文件 menu:update 同步「当前域 + 可见范围」→ 主进程重建原生菜单
 *   用户点击菜单项 → 主进程推送 menu:navigate → 本文件 switchDomain / navigate
 *
 * 页面模块统一契约：export { render(), mount(root) }
 *   render() 返回 HTML 字符串；mount(root) 负责加载数据与绑定事件（支持 async）
 */
import * as dashboard from './pages/dashboard.js';
import * as hosts from './pages/hosts.js';
import * as containers from './pages/containers.js';
import * as tasks from './pages/tasks.js';
import * as scripts from './pages/scripts.js';
import * as dbconfig from './pages/dbconfig.js';
import * as sql from './pages/sql.js';
import * as etl from './pages/etl.js';
import * as netsec from './pages/netsec.js';
import * as infosec from './pages/infosec.js';
import * as sensitive from './pages/sensitive.js';
import * as audit from './pages/audit.js';
import * as accounts from './pages/accounts.js';
import * as ledger from './pages/ledger.js';
import * as system from './pages/system.js';
import * as aiconfig from './pages/aiconfig.js';
import * as aiPanel from './aiPanel.js';
import { api } from './api.js';
import { toast } from './ui.js';
import { bootstrap, getUser } from './session.js';

const icons = {
    dashboard: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="7" height="7" rx="1.5"/><rect x="14" y="3" width="7" height="7" rx="1.5"/><rect x="3" y="14" width="7" height="7" rx="1.5"/><rect x="14" y="14" width="7" height="7" rx="1.5"/></svg>',
    server: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="2" y="4" width="20" height="6" rx="2"/><rect x="2" y="14" width="20" height="6" rx="2"/><line x1="6" y1="7" x2="6.01" y2="7"/><line x1="6" y1="17" x2="6.01" y2="17"/></svg>',
    play: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9"/><polygon points="10 8 16 12 10 16 10 8" fill="currentColor" stroke="none"/></svg>',
    code: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="8 6 3 12 8 18"/><polyline points="16 6 21 12 16 18"/><line x1="13" y1="4" x2="11" y2="20"/></svg>',
    database: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><ellipse cx="12" cy="5" rx="9" ry="3"/><path d="M3 5v14c0 1.7 4 3 9 3s9-1.3 9-3V5"/><path d="M3 12c0 1.7 4 3 9 3s9-1.3 9-3"/></svg>',
    plug: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M9 2v6"/><path d="M15 2v6"/><path d="M6 8h12v3a6 6 0 0 1-12 0z"/><path d="M12 17v5"/></svg>',
    shield: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3l8 3v6c0 5-3.5 8-8 9-4.5-1-8-4-8-9V6l8-3z"/><line x1="9" y1="12" x2="15" y2="12"/></svg>',
    scroll: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M14 3H6a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9z"/><polyline points="14 3 14 9 20 9"/><line x1="8" y1="13" x2="16" y2="13"/><line x1="8" y1="17" x2="13" y2="17"/></svg>',
    key: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="8" cy="15" r="4"/><path d="M10.8 12.2L20 3l1.5 1.5-1.5 1.5 1.5 1.5-2.5 2.5-1.5-1.5-2 2"/></svg>',
    spark: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3l1.9 5.1L19 10l-5.1 1.9L12 17l-1.9-5.1L5 10l5.1-1.9z"/><path d="M19 15l.9 2.1L22 18l-2.1.9L19 21l-.9-2.1L16 18l2.1-.9z"/></svg>',
    transfer: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="16 3 21 8 16 13"/><path d="M21 8H9"/><polyline points="8 11 3 16 8 21"/><path d="M3 16h12"/></svg>',
    activity: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="22 12 18 12 15 21 9 3 6 12 2 12"/></svg>',
    lock: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="4" y="11" width="16" height="10" rx="2"/><path d="M8 11V7a4 4 0 0 1 8 0v4"/><circle cx="12" cy="16" r="1.5"/></svg>',
    vault: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="4" width="18" height="16" rx="2"/><circle cx="12" cy="12" r="4"/><path d="M12 10v2l1.5 1.5"/></svg>',
    box: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 8l-9-5-9 5 9 5 9-5z"/><path d="M3 8v8l9 5 9-5V8"/><path d="M12 13v8"/></svg>',
    gear: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09a1.65 1.65 0 0 0-1-1.51 1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09a1.65 1.65 0 0 0 1.51-1 1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33h.08a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51h.08a1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82v.08a1.65 1.65 0 0 0 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/></svg>'
};

/**
 * 域定义（desc 用于菜单与侧边栏的 hover 提示）
 * id 必须与主进程 menuModel.js / permissions.js 保持一致，由 channel-check 校验
 */
const domainIcons = { server: icons.server, database: icons.database, security: icons.shield, system: icons.gear };
const domains = [
    { id: 'server', label: '服务器运维', desc: '主机资产 · 批量命令 · 脚本托管' },
    { id: 'database', label: '数据库运维', desc: '数据源配置 · SQL 工作台 · 数据集成' },
    { id: 'security', label: '安全运维', desc: '抓包重放 · 加解密与二维码工具箱' },
    { id: 'system', label: '系统运维', desc: '用户权限 · 安全规则 · 审计告警 · 运行参数' }
].map(d => ({ ...d, icon: domainIcons[d.id] }));

/**
 * 页面注册表
 * module 决定权限判定：用户 modules[module] 为非空等级才允许访问
 */
const pages = {
    dashboard: { label: '总览', sub: '平台运行概览', domain: 'server', icon: icons.dashboard, module: 'dashboard', mod: dashboard },
    hosts: { label: '主机管理', sub: '内网主机资产与 SSH 连接管理', domain: 'server', icon: icons.server, module: 'hosts', mod: hosts },
    containers: { label: '容器运维', sub: 'Docker 容器管理 · compose 编排 · 容器日志与命令', domain: 'server', icon: icons.box, module: 'containers', mod: containers },
    tasks: { label: '任务执行', sub: '批量命令执行 · 执行前安全校验 · 历史记录', domain: 'server', icon: icons.play, module: 'tasks', mod: tasks },
    scripts: { label: '脚本管理', sub: 'Shell / Python 脚本托管与执行', domain: 'server', icon: icons.code, module: 'scripts', mod: scripts },
    dbconfig: { label: '数据库配置', sub: '数据源增删改查 · 连接测试 · 驱动状态', domain: 'database', icon: icons.plug, module: 'dbconfig', mod: dbconfig },
    sql: { label: 'SQL 工作台', sub: '库表结构浏览 · SQL 脚本执行 · 执行历史', domain: 'database', icon: icons.database, module: 'sqltools', mod: sql },
    etl: { label: '数据集成', sub: '库对库 · 文件对库 · 库对文件 同步向导', domain: 'database', icon: icons.transfer, module: 'etl', mod: etl },
    netsec: { label: '网络安全', sub: '请求构造重放 · 本地抓包代理 · 断点改包', domain: 'security', icon: icons.activity, module: 'netsec', mod: netsec },
    infosec: { label: '信息安全', sub: '哈希 · 加解密 · JWT · 二维码工具箱', domain: 'security', icon: icons.lock, module: 'infosec', mod: infosec },
    accounts: { label: '多系统账号', sub: '第三方系统凭据加密存储 · 模拟登录', domain: 'system', icon: icons.key, module: 'accounts', mod: accounts },
    ledger: { label: '凭据台账', sub: '全量账号口令台账 · 解密查看（仅系统管理员）', domain: 'system', icon: icons.vault, module: 'ledger', mod: ledger },
    sensitive: { label: '敏感词配置', sub: '命令拦截规则 · 正则黑名单 · 白名单机制', domain: 'system', icon: icons.shield, module: 'rules', mod: sensitive },
    audit: { label: '日志审计', sub: '操作与命令全量留痕 · 异常告警', domain: 'system', icon: icons.scroll, module: 'audit', mod: audit },
    aiconfig: { label: 'AI 配置', sub: '模型提供方 · 模型清单 · Agent 能力开关', domain: 'system', icon: icons.spark, module: 'ai', mod: aiconfig },
    system: { label: '系统设置', sub: '用户角色 · 界面权限 · 并发与安全', domain: 'system', icon: icons.gear, module: 'settings', mod: system }
};

const navEl = document.getElementById('nav');
const breadcrumbEl = document.getElementById('breadcrumb');
const contentEl = document.getElementById('content');
const titleEl = document.getElementById('page-title');
const subEl = document.getElementById('page-sub');

let current = null;
let currentDomain = null;

/* ------------------------------------------------------------------
 * 权限判定
 * ------------------------------------------------------------------ */

/** 当前用户对所有模块的权限等级（系统管理员由主进程注入全 admin）
 *  演示模式（浏览器直开，无登录返回的 modules）：全模块放行，便于纯 UI 调试 */
let demoPerms = null;
const modulePerms = () => {
    const m = (getUser() || {}).modules || {};
    if (api.demoMode && !Object.keys(m).length) {
        if (!demoPerms) {
            demoPerms = {};
            Object.values(pages).forEach(p => { demoPerms[p.module] = 'admin'; });
        }
        return demoPerms;
    }
    return m;
};

/** 某页面是否对当前用户开放 */
const canAccess = id => {
    const page = pages[id];
    if (!page) return false;
    return !!modulePerms()[page.module];
};

/** 当前用户可见的页面 id 列表 */
const accessiblePages = () => Object.keys(pages).filter(canAccess);

/** 某域下当前用户可见的页面 */
const domainPages = domainId => Object.keys(pages).filter(id => pages[id].domain === domainId && canAccess(id));

/** 可见的域（至少含一个可见页面） */
const accessibleDomains = () => domains.filter(d => domainPages(d.id).length > 0);

/* ------------------------------------------------------------------
 * 应用菜单栏联动
 * ------------------------------------------------------------------ */

/**
 * 把当前域与可见范围同步给主进程 → 由主进程重建原生菜单栏
 * 菜单项按可见范围置灰，避免出现「点击无反应」的死菜单
 */
function syncMenu() {
    if (typeof api.menu === 'undefined') return;
    api.menu.update({
        domain: currentDomain,
        page: current,
        domains: accessibleDomains().map(d => d.id),
        pages: accessiblePages()
    }).catch(() => { /* 演示模式或桥未就绪时静默忽略 */ });
}

/** 菜单点击 → 切换域 / 打开页面 */
function bindMenuNavigation() {
    if (typeof api.onMenuNavigate !== 'function') return;
    api.onMenuNavigate(payload => {
        if (!payload) return;
        if (payload.type === 'domain' && payload.id) {
            switchDomain(payload.id);
        } else if (payload.type === 'page' && payload.id) {
            // 视图菜单是全域平铺的，跨域直达由 navigate 内部处理
            navigate(payload.id);
        }
    });
}

/* ------------------------------------------------------------------
 * 侧边栏（全域树 · 抽屉式）
 * 当前域自动展开；点当前域的域头收起/展开（手风琴），
 * 点其它域的域头直接切换域（重建后新当前域自动展开）。
 * 任何页面都能看到全局结构，不再「进了一域就看不见别域」。
 * ------------------------------------------------------------------ */

function buildNav() {
    const visible = accessibleDomains();
    if (!visible.length) {
        navEl.innerHTML = `<div class="nav-empty">当前账号未开通任何界面权限，请联系系统管理员</div>`;
        return;
    }
    navEl.innerHTML = visible.map(d => {
        const list = domainPages(d.id);
        const active = d.id === currentDomain;
        return `
        <div class="nav-domain ${active ? 'active expanded' : ''}">
            <div class="nav-domain-head" data-domain="${escSafe(d.id)}"
                 title="${escSafe(d.label)} · ${escSafe(d.desc || '')}">
                ${d.icon}<span>${escSafe(d.label)}</span>
                <svg class="nav-domain-caret" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="9 18 15 12 9 6"/></svg>
            </div>
            <div class="nav-domain-pages">
                ${list.map(id => {
                    const p = pages[id];
                    const level = modulePerms()[p.module];
                    const levelText = level && level !== 'admin' ? (level === 'viewer' ? '只读' : '') : '';
                    return `<div class="nav-item" data-page="${id}" title="${p.label}">
                        ${p.icon}<span>${p.label}</span>
                        ${levelText ? `<em class="nav-level">${levelText}</em>` : ''}
                    </div>`;
                }).join('')}
            </div>
        </div>`;
    }).join('');

    navEl.querySelectorAll('.nav-domain-head').forEach(el =>
        el.addEventListener('click', () => {
            const domainId = el.dataset.domain;
            if (domainId === currentDomain) {
                // 同域：仅收起/展开抽屉，不切页面
                el.parentElement.classList.toggle('expanded');
                return;
            }
            switchDomain(domainId);
        }));
    navEl.querySelectorAll('.nav-item').forEach(el =>
        el.addEventListener('click', () => navigate(el.dataset.page)));
}

/* ------------------------------------------------------------------
 * 顶栏面包屑（域 › 页面）
 * 域切换入口收拢到侧边栏全域树，顶栏只负责告知「当前位置」
 * ------------------------------------------------------------------ */

function buildBreadcrumb() {
    if (!breadcrumbEl) return;
    const d = domains.find(x => x.id === currentDomain);
    const p = pages[current];
    const parts = [];
    if (d) parts.push(`<span class="crumb">${escSafe(d.label)}</span>`);
    if (p) parts.push(`<span class="crumb current">${escSafe(p.label)}</span>`);
    breadcrumbEl.innerHTML = parts.join('<span class="crumb-sep">›</span>');
}

const escSafe = v => String(v === undefined || v === null ? '' : v)
    .replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

/* ------------------------------------------------------------------
 * 页面导航
 * ------------------------------------------------------------------ */

/** 切换域：重建侧边栏，并跳到该域第一个可见页面 */
async function switchDomain(domainId) {
    if (domainId === currentDomain) return;
    if (!domainPages(domainId).length) {
        toast(`当前账号未开通「${(domains.find(d => d.id === domainId) || {}).label || domainId}」下任何页面权限`, 'warn');
        return;
    }
    currentDomain = domainId;
    current = null;          // 强制刷新，即使目标页面与当前同名
    buildNav();
    buildBreadcrumb();
    syncMenu();
    const first = domainPages(domainId)[0];
    if (first) await navigate(first);
}

async function navigate(id) {
    const page = pages[id];
    if (!page || current === id) return;

    // 权限已被回收（如管理员刚改了权限）→ 提示并回落到首个可用页面
    if (!canAccess(id)) {
        toast(`当前账号无权访问「${page.label}」，请联系系统管理员开通该模块`, 'warn');
        const fallback = accessiblePages()[0];
        if (fallback && fallback !== id && current !== fallback) await navigate(fallback);
        return;
    }

    current = id;
    if (page.domain !== currentDomain && domainPages(page.domain).length) {
        currentDomain = page.domain;
        buildNav();
        buildBreadcrumb();
    }
    // 当前域 / 页面变化都要同步到原生菜单，保证勾选态与页面一致
    syncMenu();
    buildBreadcrumb();

    navEl.querySelectorAll('.nav-item').forEach(el =>
        el.classList.toggle('active', el.dataset.page === id));

    titleEl.textContent = page.label;
    subEl.textContent = page.sub;
    // AI 上下文跟随当前页面（工作台的上下文胶囊由此驱动）
    aiPanel.setPage({
        pageId: id,
        pageLabel: page.label,
        domainLabel: (domains.find(d => d.id === currentDomain) || {}).label || ''
    });
    contentEl.innerHTML = page.mod.render();
    contentEl.scrollTop = 0;

    try {
        await page.mod.mount(contentEl);
    } catch (err) {
        console.error('[page] mount 失败', id, err);
        toast(`「${page.label}」数据加载失败：${err.message}`, 'danger');
    }
}

// 跨页跳转（总览卡片等处的 data-goto）
contentEl.addEventListener('click', e => {
    const target = e.target.closest('[data-goto]');
    if (target) navigate(target.dataset.goto);
});

/**
 * 启动流程：先校验会话（未登录显示登录页），登录成功后才构建导航与首屏
 * 权限裁剪完全依赖登录返回的 user.modules，前端不落任何权限白名单
 */
bootstrap(() => {
    bindMenuNavigation();

    const list = accessibleDomains();
    if (!list.length) {
        navEl.innerHTML = `<div class="nav-empty">当前账号未开通任何界面权限，请联系系统管理员</div>`;
        contentEl.innerHTML = `<div class="card"><div class="empty">
            当前账号（${escSafe((getUser() || {}).username || '-')}）未开通任何界面模块权限。<br>
            请使用系统管理员账号在「系统运维 → 系统设置 → 用户与角色」中配置后重新登录。
        </div></div>`;
        syncMenu();
        aiPanel.refresh();
        return;
    }

    // 优先进入总览（若可见），否则进入首个可用页面
    currentDomain = canAccess('dashboard') ? 'server' : list[0].id;
    buildNav();
    buildBreadcrumb();
    syncMenu();
    aiPanel.init();
    navigate(canAccess('dashboard') ? 'dashboard' : domainPages(currentDomain)[0]);
});

/** 会话内权限被管理员调整后，重新构建界面（供 session.js 在有需要时调用） */
export function refreshPermissions() {
    const list = accessibleDomains();
    const stillVisible = list.some(d => d.id === currentDomain);
    if (!stillVisible) currentDomain = list.length ? list[0].id : null;
    buildNav();
    buildBreadcrumb();
    syncMenu();
    aiPanel.refresh();
    if (!canAccess(current)) {
        const first = accessiblePages()[0];
        if (first) { current = null; navigate(first); }
    }
}
