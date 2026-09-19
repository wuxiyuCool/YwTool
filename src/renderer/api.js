/**
 * 前端数据接入层
 * - Electron 环境：全部通过 window.electron.invoke 走 IPC，读写落库至主进程
 * - 浏览器直接打开：进入演示模式（只读占位数据），便于纯 UI 调试
 */
import * as demo from './demoData.js';
import { toast } from './ui.js';

const bridge = typeof window !== 'undefined' ? window.electron : null;
export const demoMode = !(bridge && typeof bridge.invoke === 'function');

const NOT_SUPPORTED = '演示模式不支持写操作，请通过 npm start 启动应用';

let unauthorizedHandler = null;

/** 注册会话失效回调（由 session.js 接管，回到登录页） */
export function setUnauthorizedHandler(fn) {
    unauthorizedHandler = fn;
}

function invoke(channel, data) {
    if (demoMode) return Promise.resolve(demoFallback(channel, data));
    return bridge.invoke(channel, data).catch(err => {
        const message = String((err && err.message) || '');

        // 会话失效：交回登录页
        if (message.includes('UNAUTHORIZED')) {
            if (typeof unauthorizedHandler === 'function') unauthorizedHandler();
            throw err;
        }

        // 权限不足：统一提示并返回失败结构，避免页面未捕获导致静默失败
        if (message.includes('FORBIDDEN')) {
            const clean = message.replace(/^.*FORBIDDEN:\s*/, '');
            toast(clean, 'warn');
            return { ok: false, code: 'FORBIDDEN', message: clean };
        }

        throw err;
    });
}

/** 演示模式下的只读数据回退 */
function demoFallback(channel, data) {
    switch (channel) {
        case 'auth:session': return { ok: false, loggedIn: false };
        case 'auth:logout': return { ok: true };
        case 'menu:model': return demo.demoMenuModel;
        case 'menu:update': return { ok: false, demo: true, message: '演示模式下无原生菜单栏' };
        case 'alerts:list': return [];
        case 'alerts:unread': return { count: 0, latest: [] };
        case 'schedules:list': return demo.demoSchedules;
        case 'sqlScripts:list': return demo.demoSqlScripts;
        case 'sqlHistory:list': return demo.demoSqlHistory;
        case 'db:tables': return demo.demoDbTables(data);
        case 'db:schema': return demo.demoDbSchema(data);
        case 'db:describe': return demo.demoDbDescribe(data);
        case 'sql:execute': return demoQuery(data);
        case 'hosts:list': return demo.demoHosts;
        case 'scripts:list': return demo.demoScripts;
        case 'rules:list': return demo.demoRules;
        case 'accounts:list': return demo.demoAccounts;
        case 'tasks:list': return demo.demoTasks;
        case 'tasks:detail': return demo.demoTasks.find(t => t.id === data) || null;
        case 'audit:query': return { ok: true, records: queryDemoLogs(data) };
        case 'audit:stats':
            return { todayTotal: 7, todayBlocked: 1, todayFailed: 2, files: 3 };
        case 'audit:paths':
            return { logDir: demo.demoEnv.logDir, today: demo.demoEnv.todayLog, dataFile: demo.demoEnv.dataFile };
        case 'system:env': return demo.demoEnv;
        case 'system:config:get': return demo.demoConfig;
        case 'system:users:list': return demo.demoUsers;
        case 'system:modules:list': return demo.demoModuleMeta;
        case 'system:perms:get': return demo.demoPerms;
        case 'ai:config:get': return demo.demoAiConfig;
        case 'ai:chat:history': return demo.demoAiHistory;
        case 'ai:chat:clear': return { ok: true };
        case 'ai:sessions:list':
            return {
                ok: true, activeId: 'demo',
                sessions: [{ id: 'demo', title: '演示会话', messageCount: 1, updatedAt: '2026-09-18 09:00' }]
            };
        case 'ai:sessions:new': return { ok: true, session: { id: 'demo', title: '新会话', messageCount: 0 } };
        case 'ai:sessions:switch': return { ok: true, messages: demo.demoAiHistory.messages };
        case 'ai:sessions:delete': return { ok: true, activeId: 'demo' };
        case 'ai:script:generate': return demo.demoAiScript;
        case 'ai:script:optimize': return demo.demoAiScript;
        case 'ai:model:get':
            return {
                ok: true, provider: 'deepseek', configured: true,
                defaultModel: 'deepseek-chat', model: 'deepseek-chat',
                providers: demo.demoAiConfig.config.providers, prefs: {}
            };
        case 'ai:model:save': return { ok: true, model: (data && data.model) || 'deepseek-chat' };
        case 'ai:agent:get':
            return {
                ok: true, enabled: false, userPref: null,
                global: demo.demoAiAgentConfig,
                tools: demo.demoAiTools
            };
        case 'ai:agent:tools':
            return { ok: true, catalog: demo.demoAiAgentConfig, tools: demo.demoAiTools, defaults: demo.demoAiAgentConfig };
        case 'ai:agent:save': return { ok: true, agent: { ...demo.demoAiAgentConfig, ...(data || {}) } };
        case 'ai:agent:toggle':
            return { ok: !(data && data.enabled) || false, message: '演示模式下 Agent 能力不可用' };
        case 'ai:chat': {
            const user = String((data && data.messages && data.messages.length && data.messages[data.messages.length - 1] && data.messages[data.messages.length - 1].content) || '');
            return {
                ok: true,
                text: `演示模式（未连接本地服务）：已收到您的提问「${user.slice(0, 60)}」，接入真实模型后即可返回智能回复；Agent 能力需在主进程环境下才可用。`,
                durationMs: 8
            };
        }
        case 'ai:test': return { ok: true, durationMs: 120, message: `连接成功 · DeepSeek · ${(data && data.model) || 'deepseek-chat'}（演示）` };
        case 'db:etl:preview':
            return {
                ok: true, kind: 'db', total: 120,
                columns: [
                    { name: 'id', type: 'integer' },
                    { name: 'host_name', type: 'string' },
                    { name: 'status', type: 'string' },
                    { name: 'created_at', type: 'datetime' }
                ],
                sample: [
                    { id: 1, host_name: 'app-server-01', status: 'online', created_at: '2026-09-18 09:00:00' },
                    { id: 2, host_name: 'db-server-01', status: 'online', created_at: '2026-09-18 09:05:00' }
                ],
                targetTable: (data && data.target && data.target.table) || 'app_host',
                targetColumns: [
                    { name: 'id', type: 'int', key: 'PRI' },
                    { name: 'name', type: 'varchar(64)' },
                    { name: 'status', type: 'varchar(16)' },
                    { name: 'created_at', type: 'datetime' }
                ],
                warnings: []
            };
        case 'db:etl:run':
            return { ok: false, message: '演示模式不执行真实同步，请通过 npm start 启动应用后再运行任务' };
        case 'db:etl:pickFile':
            return { ok: false, message: '演示模式不支持本地文件选择' };
        case 'db:etl:tasks:list': return demo.demoEtlTasks;
        case 'db:etl:tasks:save': return { ok: true, task: { id: 'et_demo', ...(data || {}) } };
        case 'db:etl:tasks:delete': return { ok: true };
        case 'db:etl:runs': return demo.demoEtlRuns;
        case 'dbconfig:list': return demo.demoDbSources;
        case 'dbconfig:drivers': return demo.demoDriverMeta;
        case 'ledger:list': return demoLedgerRows();
        case 'ledger:reveal': return { ok: false, message: '演示模式不支持查看明文凭据' };
        case 'dashboard:overview': return {
            stats: {
                hostTotal: demo.demoHosts.length,
                hostOnline: demo.demoHosts.filter(h => h.status === 'online').length,
                hostOffline: demo.demoHosts.filter(h => h.status !== 'online').length,
                taskWeek: demo.demoTasks.length,
                taskSuccess: demo.demoTasks.filter(t => t.status === 'success').length,
                taskFailed: demo.demoTasks.filter(t => t.status === 'failed').length,
                blocked: demo.demoTasks.filter(t => t.status === 'blocked').length,
                ruleEnabled: demo.demoRules.filter(r => r.enabled).length,
                scriptTotal: demo.demoScripts.length,
                scriptShell: demo.demoScripts.filter(s => s.type === 'shell').length,
                scriptPython: demo.demoScripts.filter(s => s.type === 'python').length,
                auditToday: { todayTotal: 7, todayBlocked: 1, todayFailed: 2, files: 3 }
            },
            recentTasks: demo.demoTasks.slice(0, 6),
            alerts: [
                { level: 'danger', text: '命令 "rm -rf /var/log" 命中高危规则，已在执行前拦截', time: '13:58' },
                { level: 'warn', text: '主机 db-server-02 SSH 连接失败（超时）', time: '13:12' }
            ]
        };
        case 'rules:validate': return validateDemo(data && data.cmd);
        default:
            return { ok: false, message: NOT_SUPPORTED };
    }
}

/** 演示模式：凭据台账聚合行（与主进程 ledgerHandler 出参同构） */
function demoLedgerRows() {
    const MASK = '●●●●●●●●';
    return [
        ...(demo.demoAccounts || []).map(a => ({
            kind: 'account', id: a.id, name: a.name, target: a.url || '-', user: a.user || '-',
            hasPassword: !!a.password, passwordMasked: a.password ? MASK : '', note: a.scriptName || '', updatedAt: a.lastSyncAt || ''
        })),
        ...(demo.demoDbSources || []).map(s => ({
            kind: 'db', id: s.id, name: s.name, target: [s.host, s.port, s.database].filter(Boolean).join(':'), user: s.user || '-',
            hasPassword: !!s.password, passwordMasked: s.password ? MASK : '', note: s.type || '', updatedAt: s.lastTestAt || ''
        })),
        ...(demo.demoHosts || []).filter(h => h.authType === 'password').map(h => ({
            kind: 'host', id: h.id, name: h.name, target: `${h.ip}:${h.port || 22}`, user: h.user || '-',
            hasPassword: !!h.password, passwordMasked: h.password ? MASK : '', note: (h.tags || []).join('、'), updatedAt: h.lastConnectedAt || ''
        }))
    ];
}

function queryDemoLogs(query = {}) {
    const { type = 'all', result = 'all', keyword = '' } = query || {};
    const kw = String(keyword).toLowerCase();
    return demo.demoLogs.filter(l =>
        (type === 'all' || l.type === type) &&
        (result === 'all' || l.result === result) &&
        (!kw || (l.user + l.detail).toLowerCase().includes(kw)));
}

function validateDemo(cmd) {
    const command = String(cmd || '').trim();
    const hits = demo.demoRules
        .filter(r => r.enabled && r.mode === 'blacklist')
        .filter(r => { try { return new RegExp(r.pattern).test(command); } catch (e) { return false; } })
        .map(r => ({ pattern: r.pattern, desc: r.desc, level: r.level }));
    if (hits.length) {
        return { ok: false, blocked: true, hits, reason: '命令已拦截：' + hits.map(h => `[${h.level}] ${h.desc}`).join('、') };
    }
    return { ok: true, blocked: false, hits: [], reason: '校验通过：未命中敏感规则' };
}

/** 演示模式下的 SQL 执行：返回示例结果集，便于纯前端调试渲染 */
function demoQuery(data) {
    const sql = String((data && data.sql) || '');
    if (/^\s*drop\s+(database|schema)/i.test(sql)) {
        return { ok: false, blocked: true, message: '已拦截：不允许执行 DROP DATABASE / DROP SCHEMA' };
    }
    return {
        ok: true,
        source: { id: (data && data.sourceId) || 'd_02', name: 'MySQL（业务库）', type: 'mysql' },
        totalDurationMs: 24,
        statements: [{
            sql, ok: true, durationMs: 24, truncated: false,
            columns: demo.demoSqlColumns,
            rows: demo.demoSqlRows,
            rowCount: demo.demoSqlRows.length
        }]
    };
}

export const api = {
    demoMode,

    app: {
        info: () => invoke('app:info')
    },

    /** 应用菜单栏：结构下发 + 可见范围同步 + 菜单点击订阅 */
    menu: {
        model: () => invoke('menu:model'),
        update: payload => invoke('menu:update', payload)
    },

    auth: {
        login: payload => invoke('auth:login', payload),
        logout: () => invoke('auth:logout'),
        session: () => invoke('auth:session'),
        changePassword: payload => invoke('auth:password', payload),
        resetPassword: payload => invoke('auth:resetPassword', payload)
    },

    alerts: {
        list: (query = {}) => invoke('alerts:list', query),
        unread: () => invoke('alerts:unread'),
        ack: id => invoke('alerts:ack', id),
        ackAll: () => invoke('alerts:ackAll'),
        clear: () => invoke('alerts:clear')
    },

    schedules: {
        list: () => invoke('schedules:list'),
        save: payload => invoke('schedules:save', payload),
        remove: id => invoke('schedules:delete', id),
        toggle: (id, enabled) => invoke('schedules:toggle', { id, enabled }),
        runNow: id => invoke('schedules:runNow', id)
    },

    hosts: {
        list: () => invoke('hosts:list'),
        save: payload => invoke('hosts:save', payload),
        remove: id => invoke('hosts:delete', id),
        test: id => invoke('hosts:test', id),
        exec: (id, cmd) => invoke('hosts:exec', { id, cmd })
    },

    tasks: {
        list: (limit = 100) => invoke('tasks:list', { limit }),
        detail: id => invoke('tasks:detail', id),
        validate: payload => invoke('tasks:validate', payload),
        run: payload => invoke('tasks:run', payload),
        exportCsv: id => invoke('tasks:export', id)
    },

    scripts: {
        list: () => invoke('scripts:list'),
        detail: id => invoke('scripts:detail', id),
        save: payload => invoke('scripts:save', payload),
        remove: id => invoke('scripts:delete', id),
        run: payload => invoke('scripts:run', payload),
        lint: payload => invoke('scripts:lint', payload),
        execOne: (id, hostId) => invoke('scripts:execOne', { id, hostId })
    },

    rules: {
        list: () => invoke('rules:list'),
        save: payload => invoke('rules:save', payload),
        remove: id => invoke('rules:delete', id),
        toggle: (id, enabled) => invoke('rules:toggle', { id, enabled }),
        validate: cmd => invoke('rules:validate', { cmd })
    },

    accounts: {
        list: () => invoke('accounts:list'),
        save: payload => invoke('accounts:save', payload),
        remove: id => invoke('accounts:delete', id),
        reveal: id => invoke('accounts:reveal', id),
        reset: id => invoke('accounts:reset', id),
        loginTest: id => invoke('accounts:loginTest', id),
        savePolicy: policy => invoke('accounts:policy:save', policy)
    },

    audit: {
        query: query => invoke('audit:query', query),
        stats: () => invoke('audit:stats'),
        append: entry => invoke('audit:append', entry),
        cleanup: days => invoke('audit:cleanup', days),
        paths: () => invoke('audit:paths')
    },

    system: {
        env: () => invoke('system:env'),
        getConfig: () => invoke('system:config:get'),
        saveConfig: patch => invoke('system:config:save', patch),
        users: {
            list: () => invoke('system:users:list'),
            save: payload => invoke('system:users:save', payload),
            remove: id => invoke('system:users:delete', id)
        },
        modules: () => invoke('system:modules:list'),
        perms: {
            get: () => invoke('system:perms:get'),
            save: payload => invoke('system:perms:save', payload),
            reset: payload => invoke('system:perms:reset', payload)
        },
        /** 配置备份：口令加密的导出 / 导入（merge 合并 · replace 替换） */
        backup: {
            export: payload => invoke('system:backup:export', payload),
            import: payload => invoke('system:backup:import', payload)
        }
    },

    /** 凭据台账：聚合业务系统 / 数据源 / 主机的账号口令（仅系统管理员） */
    ledger: {
        list: () => invoke('ledger:list'),
        reveal: payload => invoke('ledger:reveal', payload)
    },

    /** 数据库配置（数据库运维域 · 独立模块） */
    dbConfig: {
        list: () => invoke('dbconfig:list'),
        detail: id => invoke('dbconfig:detail', id),
        drivers: () => invoke('dbconfig:drivers'),
        save: payload => invoke('dbconfig:save', payload),
        remove: id => invoke('dbconfig:delete', id),
        toggle: (id, enabled) => invoke('dbconfig:toggle', { id, enabled }),
        test: id => invoke('dbconfig:test', id),
        exportConfig: () => invoke('dbconfig:export'),
        importConfig: (sources, overwrite) => invoke('dbconfig:import', { sources, overwrite })
    },

    /** SQL 工作台 */
    sql: {
        execute: (sourceId, sql) => invoke('sql:execute', { sourceId, sql }),
        tables: sourceId => invoke('db:tables', sourceId),
        describe: (sourceId, table) => invoke('db:describe', { sourceId, table }),
        schema: sourceId => invoke('db:schema', sourceId),
        scripts: {
            list: () => invoke('sqlScripts:list'),
            save: payload => invoke('sqlScripts:save', payload),
            remove: id => invoke('sqlScripts:delete', id)
        },
        history: (limit = 60) => invoke('sqlHistory:list', { limit }),
        exportCsv: payload => invoke('sql:export', payload)
    },

    /**
     * 数据集成（ETL）：库对库 / 文件对库 / 库对文件，统一「源 → 字段映射 → 目标」
     * 大文件内容不经过渲染进程：选文件只回传路径，解析与写入都在主进程完成
     */
    etl: {
        preview: (source, target) => invoke('db:etl:preview', { source, target }),
        run: task => invoke('db:etl:run', { task }),
        pickFile: (kind = 'open') => invoke('db:etl:pickFile', { kind }),
        tasks: {
            list: () => invoke('db:etl:tasks:list'),
            save: payload => invoke('db:etl:tasks:save', payload),
            remove: id => invoke('db:etl:tasks:delete', id)
        },
        runs: (limit = 20) => invoke('db:etl:runs', { limit })
    },

    dashboard: {
        overview: () => invoke('dashboard:overview')
    },

    /** AI 助手：模型 / Agent / 对话 / 会话管理 / 脚本生成与优化 */
    ai: {
        config: {
            get: () => invoke('ai:config:get'),
            save: payload => invoke('ai:config:save', payload)
        },
        test: model => invoke('ai:test', { model }),
        chat: (messages, agent = false) => invoke('ai:chat', { messages, agent }),
        chatHistory: () => invoke('ai:chat:history'),
        chatClear: () => invoke('ai:chat:clear'),
        /** 模型切换：读取可选清单 + 保存用户级偏好 */
        model: {
            get: () => invoke('ai:model:get'),
            save: model => invoke('ai:model:save', { model })
        },
        /** Agent 能力：配置与工具清单读取 / 管理员保存 / 用户自助开关 */
        agent: {
            get: () => invoke('ai:agent:get'),
            tools: () => invoke('ai:agent:tools'),
            save: payload => invoke('ai:agent:save', payload),
            toggle: enabled => invoke('ai:agent:toggle', { enabled })
        },
        /** 多会话管理：列表 / 新建 / 切换 / 删除 */
        sessions: {
            list: () => invoke('ai:sessions:list'),
            create: () => invoke('ai:sessions:new'),
            switchTo: id => invoke('ai:sessions:switch', { id }),
            remove: id => invoke('ai:sessions:delete', { id })
        },
        script: {
            generate: (requirement, type) => invoke('ai:script:generate', { requirement, type }),
            optimize: (name, type, content, hint) => invoke('ai:script:optimize', { name, type, content, hint })
        }
    },

    /** 任务执行进度推送（主进程 → 渲染进程） */
    onTaskProgress: callback => {
        if (demoMode || typeof bridge.on !== 'function') return () => {};
        return bridge.on('task:progress', callback);
    },

    /** 告警实时推送 */
    onAlert: callback => {
        if (demoMode || typeof bridge.on !== 'function') return () => {};
        return bridge.on('alert:new', callback);
    },

    /** 定时任务执行进度推送 */
    onScheduleProgress: callback => {
        if (demoMode || typeof bridge.on !== 'function') return () => {};
        return bridge.on('schedule:progress', callback);
    },

    /** 应用菜单栏点击（主进程 → 渲染进程：切换域 / 打开页面） */
    onMenuNavigate: callback => {
        if (demoMode || typeof bridge.on !== 'function') return () => {};
        return bridge.on('menu:navigate', callback);
    },

    /** AI 对话流式推送（主进程 → 渲染进程：逐段增量） */
    onAiStream: callback => {
        if (demoMode || typeof bridge.on !== 'function') return () => {};
        return bridge.on('ai:stream', callback);
    },

    /** AI Agent 工具执行轨迹推送（调用 / 结果） */
    onAiStep: callback => {
        if (demoMode || typeof bridge.on !== 'function') return () => {};
        return bridge.on('ai:step', callback);
    },

    /** ETL 同步任务进度推送（读取行数 / 写入行数 / 批次数） */
    onDataProgress: callback => {
        if (demoMode || typeof bridge.on !== 'function') return () => {};
        return bridge.on('data:progress', callback);
    }
};

export default api;
