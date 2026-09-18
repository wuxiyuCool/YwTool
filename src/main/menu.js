/**
 * 应用级菜单栏（文件 / 视图）
 * ------------------------------------------------------------------
 * 设计要点：
 *   1. 域切换与页面导航交由菜单承载，界面侧仅做侧边栏导航（顶栏胶囊已移除）
 *   2. 菜单栏展示的是「全量结构」，实际可用性由渲染进程的权限裁剪决定：
 *      主进程只负责把「某结构项是否属于当前账号可见范围」回推给菜单，
 *      这样既避免出现点了没反应的死菜单，也不会把权限判定逻辑搬到主进程。
 *   3. 渲染进程在登录完成 / 权限刷新 / 页面切换时调用 menu:update 同步状态，
 *      主进程据此重建菜单（含复选框勾选态与域内页面的启用态）。
 *
 * 数据流：
 *   渲染进程 menu:update({ domain, page, domains, pages })  →  主进程 rebuild()
 *   菜单项 click  →  webContents.send('menu:navigate', payload)  →  渲染进程 navigate/switchDomain
 */
const { Menu, app } = require('electron');
const build = require('./menuModel');

/** 最近一次由渲染进程同步过来的界面状态 */
let snapshot = {
    domain: null,
    page: null,
    domains: [],   // 当前账号可见的域 id
    pages: []      // 当前账号可见的页面 id
};

let targetWindow = null;

/** 域 / 页面元数据统一从 menuModel 读取，渲染进程无需重复维护 */
const DOMAINS = build.DOMAINS;
const PAGES = build.PAGES;
const DOMAIN_LABEL = build.DOMAIN_LABEL;
const PAGE_LABEL = build.PAGE_LABEL;
const pageDomain = build.pageDomain;

/** 依据可见范围决定菜单项的 enabled 状态 */
const domainEnabled = id => snapshot.domains.includes(id);
const pageEnabled = id => snapshot.pages.includes(id);

/** 通知渲染进程切换视图 */
function send(payload) {
    if (targetWindow && !targetWindow.isDestroyed()) {
        targetWindow.webContents.send('menu:navigate', payload);
    }
}

/**
 * 构建完整菜单模板
 * 结构（与界面一一对应）：
 *   文件 → 服务器运维 / 数据库运维 / 系统运维（域切换）· 退出
 *   视图 → 总览（顶层） + 服务器运维 / 数据库运维 / 系统运维 子菜单（域内页面）· 窗口功能
 */
function buildTemplate() {
    return [
        {
            label: '文件',
            submenu: [
                {
                    label: '服务器运维',
                    type: 'checkbox',
                    checked: snapshot.domain === 'server',
                    enabled: domainEnabled('server'),
                    accelerator: 'CmdOrCtrl+1',
                    click: () => send({ type: 'domain', id: 'server' })
                },
                {
                    label: '数据库运维',
                    type: 'checkbox',
                    checked: snapshot.domain === 'database',
                    enabled: domainEnabled('database'),
                    accelerator: 'CmdOrCtrl+2',
                    click: () => send({ type: 'domain', id: 'database' })
                },
                {
                    label: '系统运维',
                    type: 'checkbox',
                    checked: snapshot.domain === 'system',
                    enabled: domainEnabled('system'),
                    accelerator: 'CmdOrCtrl+3',
                    click: () => send({ type: 'domain', id: 'system' })
                },
                { type: 'separator' },
                { label: '退出', role: 'quit' }
            ]
        },
        {
            label: '视图',
            submenu: [
                // 按域分组：每个域一个子菜单，域内的页面平铺其中
                // 不可见页面禁用而非隐藏，菜单结构保持稳定
                ...DOMAINS.map(d => {
                    const items = PAGES.filter(p => p.domain === d.id).map(p => ({
                        label: p.label,
                        type: 'radio',
                        checked: snapshot.page === p.id,
                        enabled: pageEnabled(p.id),
                        click: () => send({ type: 'page', id: p.id })
                    }));
                    return {
                        label: d.label,
                        enabled: items.some(i => i.enabled),
                        submenu: items
                    };
                }),
                { type: 'separator' },
                { label: '重新加载', role: 'reload' },
                { label: '开发者工具', role: 'toggleDevTools' },
                { type: 'separator' },
                { label: '全屏', role: 'togglefullscreen' }
            ]
        }
    ];
}

/** 重建并应用菜单（无窗口时跳过，避免测试环境下的空指针） */
function rebuild() {
    if (!targetWindow) return;
    Menu.setApplicationMenu(Menu.buildFromTemplate(buildTemplate()));
}

/**
 * 绑定窗口并完成首次构建
 * @param {import('electron').BrowserWindow} win
 */
function attach(win) {
    targetWindow = win;
    rebuild();
}

/**
 * 渲染进程同步界面状态后重建菜单
 * 只接受白名单字段，避免渲染进程构造出非法结构
 */
function update(payload = {}) {
    if (payload.domain !== undefined) snapshot.domain = payload.domain;
    if (payload.page !== undefined) snapshot.page = payload.page;
    if (Array.isArray(payload.domains)) snapshot.domains = payload.domains.filter(Boolean);
    if (Array.isArray(payload.pages)) snapshot.pages = payload.pages.filter(Boolean);
    rebuild();
    return { ok: true, domain: snapshot.domain, page: snapshot.page };
}

/** 当前菜单快照（供自检与调试使用） */
const state = () => ({
    domain: snapshot.domain,
    page: snapshot.page,
    domains: snapshot.domains.slice(),
    pages: snapshot.pages.slice()
});

/** 用户登出时回收菜单（避免残留上一个账号的可见范围） */
function reset() {
    snapshot = { domain: null, page: null, domains: [], pages: [] };
    rebuild();
    return { ok: true };
}

module.exports = {
    attach, rebuild, update, state, reset,
    buildTemplate, build,
    DOMAINS, PAGES, DOMAIN_LABEL, PAGE_LABEL, pageDomain,
    version: () => app.getVersion()
};
