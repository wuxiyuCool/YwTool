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
        case 'db:meta': return {
            ok: true, type: 'mysql',
            categories: [
                { id: 'tables', label: '表' },
                { id: 'views', label: '视图' },
                { id: 'procedures', label: '存储过程' },
                { id: 'functions', label: '函数' },
                { id: 'triggers', label: '触发器' },
                { id: 'events', label: '定时事件' }
            ]
        };
        case 'db:objects': {
            if (data && data.category === 'tables') {
                const r = demo.demoDbTables(data.sourceId);
                return { ok: !!(r && r.ok), objects: (r && r.tables) || [] };
            }
            return { ok: true, objects: demoMetaObjects(data && data.category) };
        }
        case 'db:ddl': return { ok: true, text: `-- 演示模式：${data && data.category} "${data && data.name}" 的定义占位\nSELECT 'demo' /* ${data && data.name} */;` };
        case 'db:schema': return demo.demoDbSchema(data);
        case 'db:describe': return demo.demoDbDescribe(data);
        case 'sql:execute': return demoQuery(data);
        case 'hosts:list': return demo.demoHosts;
        case 'docker:host:list': return {
            ok: true,
            endpoints: [{ id: 'dh_local', name: '本机 Docker（演示）', kind: 'pipe', tags: ['本地'], status: 'unknown', hasToken: false, tokenMasked: '' }],
            hosts: (demo.demoHosts || []).slice(0, 3).map(h => ({ id: h.id, name: h.name, ip: h.ip, authType: h.authType, hasPassword: !!h.password }))
        };
        case 'docker:containers': return { ok: true, containers: [], stacks: [] };
        case 'docker:images': return { ok: true, images: [] };
        case 'docker:info': return { ok: false, message: '演示模式无法连接 Docker 引擎' };
        case 'kube:clusters:list': return { clusters: [{ id: 'kc_local', name: '本机 kubectl（演示）', mode: 'local', namespace: 'default' }], hosts: [] };
        case 'kube:resources': return { ok: true, resources: ['pods', 'deployments', 'statefulsets', 'daemonsets', 'jobs', 'cronjobs', 'services', 'ingresses', 'nodes', 'namespaces', 'configmaps', 'events'] };
        case 'kube:overview': return { ok: false, message: '演示模式无法访问真实集群，请在应用内（npm start）查看' };
        case 'kube:get': return { ok: true, resource: data && data.resource, rows: [] };
        case 'scripts:list': return demo.demoScripts;
        case 'rules:list': return demo.demoRules;
        case 'accounts:list': return demo.demoAccounts;
        case 'tasks:list': return demo.demoTasks;
        case 'tasks:detail': return demo.demoTasks.find(t => t.id === data) || null;
        case 'terminal:list': return { ok: true, sessions: [] };
        case 'terminal:open': return { ok: false, message: '演示模式无法建立真实 SSH 终端会话，请在应用内（npm start）使用' };
        case 'audit:query': return { ok: true, records: queryDemoLogs(data) };
        case 'audit:stats':
            return { todayTotal: 7, todayBlocked: 1, todayFailed: 2, files: 3 };
        case 'audit:paths':
            return { logDir: demo.demoEnv.logDir, today: demo.demoEnv.todayLog, dataFile: demo.demoEnv.dataFile };
        case 'system:env': return demo.demoEnv;
        case 'system:secrets:status': return { ok: true, file: '(演示模式)', exists: false, error: null, aiKeys: [], secretKeys: [], count: 0 };
        case 'system:config:get': return demo.demoConfig;
        case 'system:users:list': return demo.demoUsers;
        case 'system:modules:list': return demo.demoModuleMeta;
        case 'system:perms:get': return demo.demoPerms;
        case 'ai:config:get': return demo.demoAiConfig;
        case 'ai:roles:list': return { ok: true, current: '', roles: demoAiRoles() };
        case 'ai:role:save': return { ok: true, role: (data && data.roleId) || '' };
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
        case 'ledger:status': return { ok: true, unlocked: false, until: 0 };
        case 'ledger:unlock': return { ok: false, message: '演示模式不支持台账解锁' };
        case 'ledger:lock': return { ok: true };
        case 'netsec:proxy:status': return { running: false, port: 0, breakpoints: false, httpsTunnel: true, pendingBreakpoints: 0, stats: { requests: 0, tunnels: 0, bytes: 0 } };
        case 'netsec:cases:list': return [{ id: 'api_demo1', name: '示例：本机健康检查', method: 'GET', url: 'http://127.0.0.1:8080/health', headers: '{}', body: '' }];
        case 'netsec:history:list': return [];
        case 'sec:ciphers':
            return ['AES-128-CBC', 'AES-192-CBC', 'AES-256-CBC', 'AES-128-ECB', 'AES-192-ECB', 'AES-256-ECB', 'AES-128-CTR', 'AES-256-CTR', 'AES-256-GCM', '3DES-CBC', 'RC4'];
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
    const KIND_LABEL = { account: '业务系统', db: '数据源', host: '主机 SSH', docker: 'Docker 端点' };
    const GOTO = { account: 'accounts', db: 'dbconfig', host: 'hosts', docker: 'containers' };
    const wrap = (kind, rest) => ({ kind, kindLabel: KIND_LABEL[kind], goto: GOTO[kind], expiresAt: '', ...rest });
    return [
        ...(demo.demoAccounts || []).map(a => wrap('account', {
            id: a.id, name: a.name, target: a.url || '-', user: a.user || '-',
            hasPassword: !!a.password, passwordMasked: a.password ? MASK : '', note: a.scriptName || '', updatedAt: a.lastSyncAt || '',
            expiresAt: a.expiresAt || ''
        })),
        ...(demo.demoDbSources || []).map(s => wrap('db', {
            id: s.id, name: s.name, target: [s.host, s.port, s.database].filter(Boolean).join(':'), user: s.user || '-',
            hasPassword: !!s.password, passwordMasked: s.password ? MASK : '', note: s.type || '', updatedAt: s.lastTestAt || ''
        })),
        ...(demo.demoHosts || []).filter(h => h.authType === 'password').map(h => wrap('host', {
            id: h.id, name: h.name, target: `${h.ip}:${h.port || 22}`, user: h.user || '-',
            hasPassword: !!h.password, passwordMasked: h.password ? MASK : '', note: (h.tags || []).join('、'), updatedAt: h.lastConnectedAt || ''
        }))
    ];
}

/** 演示模式：非表类元数据对象样例 */
function demoMetaObjects(category) {
    const MAP = {
        views: [{ name: 'v_app_host', comment: '主机在线视图' }],
        matviews: [{ name: 'mv_host_daily', comment: '' }],
        procedures: [{ name: 'sp_cleanup_logs', comment: '' }],
        functions: [{ name: 'fn_status_text', comment: '' }],
        packages: [{ name: 'PKG_OPS', comment: 'VALID' }],
        sequences: [{ name: 'SEQ_TASK_ID', comment: 'MIN 1 MAX 999999 + 1' }],
        triggers: [{ name: 'trg_host_touch', comment: 'app_host' }],
        events: [{ name: 'ev_daily_stat', comment: '每日统计' }],
        jobs: [{ name: 'JOB_HOUSEKEEP', comment: 'ENABLED' }]
    };
    return MAP[category] || [];
}

/** 演示模式：提示词角色预设（与主进程 aiRoles 种子同构，仅展示下拉用） */
function demoAiRoles() {
    return [
        { id: 'role_general', name: '通用运维助手', desc: '平台默认角色', builtin: true },
        { id: 'role_script', name: '脚本开发专家', desc: 'Shell / Python 规范', builtin: true },
        { id: 'role_dba', name: '数据库管理员（DBA）', desc: 'Oracle / MySQL / PG', builtin: true },
        { id: 'role_security', name: '安全合规审查员', desc: '命令与凭据风险', builtin: true },
        { id: 'role_docker', name: '容器化工程师', desc: 'Docker / compose', builtin: true },
        { id: 'role_incident', name: '故障根因分析师', desc: '日志与时间线', builtin: true }
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

    /** 主机管理 */
    hosts: {
        list: () => invoke('hosts:list'),
        save: payload => invoke('hosts:save', payload),
        remove: id => invoke('hosts:delete', id),
        test: id => invoke('hosts:test', id),
        exec: (id, cmd) => invoke('hosts:exec', { id, cmd })
    },

    /** 容器运维（Docker）：端点、容器、镜像、日志、exec、compose */
    docker: {
        hosts: {
            list: () => invoke('docker:host:list'),
            save: payload => invoke('docker:host:save', payload),
            remove: id => invoke('docker:host:delete', id),
            test: id => invoke('docker:host:test', id)
        },
        containers: (hostId, all = true) => invoke('docker:containers', { hostId, all }),
        images: hostId => invoke('docker:images', { hostId }),
        info: hostId => invoke('docker:info', { hostId }),
        imageDetail: (hostId, ref) => invoke('docker:image:detail', { hostId, ref }),
        logs: (hostId, id, tail) => invoke('docker:logs', { hostId, id, tail }),
        run: (hostId, action, id, force) => invoke('docker:run', { hostId, action, id, force }),
        stackRun: (hostId, project, action) => invoke('docker:stack:run', { hostId, project, action }),
        exec: (hostId, id, cmd) => invoke('docker:exec', { hostId, id, cmd }),
        compose: (yaml, action) => invoke('docker:compose:run', { yaml, action })
    },

    /** K8s 集群概览：local（本机 kubectl）/ ssh（跳板机 kubectl）双模式 */
    kube: {
        clusters: () => invoke('kube:clusters:list'),
        save: payload => invoke('kube:cluster:save', payload),
        remove: id => invoke('kube:cluster:delete', id),
        test: id => invoke('kube:cluster:test', id),
        overview: clusterId => invoke('kube:overview', { clusterId }),
        get: (clusterId, resource, opts = {}) => invoke('kube:get', { clusterId, resource, ...opts }),
        logs: (clusterId, pod, namespace, tail) => invoke('kube:logs', { clusterId, pod, namespace, tail }),
        run: (clusterId, command) => invoke('kube:run', { clusterId, command }),
        resources: () => invoke('kube:resources')
    },

    tasks: {
        list: (limit = 100) => invoke('tasks:list', { limit }),
        detail: id => invoke('tasks:detail', id),
        validate: payload => invoke('tasks:validate', payload),
        run: payload => invoke('tasks:run', payload),
        exportCsv: id => invoke('tasks:export', id)
    },

    /** 交互式终端（Xshell 式工作台）：open 建会话，input/resize/close 交互，onData/onExit 推送 */
    terminal: {
        open: payload => invoke('terminal:open', payload),
        input: (sessionId, data) => invoke('terminal:input', { sessionId, data }),
        resize: (sessionId, cols, rows) => invoke('terminal:resize', { sessionId, cols, rows }),
        close: sessionId => invoke('terminal:close', { sessionId }),
        list: () => invoke('terminal:list'),
        runScript: (sessionId, scriptId) => invoke('terminal:runScript', { sessionId, scriptId }),
        onData: callback => {
            if (demoMode || typeof bridge.on !== 'function') return () => {};
            return bridge.on('terminal:data', callback);
        },
        onExit: callback => {
            if (demoMode || typeof bridge.on !== 'function') return () => {};
            return bridge.on('terminal:exit', callback);
        }
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
        },
        /** 外置密钥配置：状态查看 / 生成模板 / 明文转本机密文 */
        secrets: {
            status: () => invoke('system:secrets:status'),
            template: () => invoke('system:secrets:template'),
            encrypt: plain => invoke('system:secrets:encrypt', { plain })
        }
    },

    /** 凭据台账：聚合业务系统 / 数据源 / 主机 / Docker 端点的账号口令（仅系统管理员） */
    ledger: {
        list: () => invoke('ledger:list'),
        reveal: payload => invoke('ledger:reveal', payload),
        unlock: password => invoke('ledger:unlock', { password }),
        lock: () => invoke('ledger:lock'),
        status: () => invoke('ledger:status')
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
        /** 元数据对象分类：方言支持的分组（表/视图/存储过程/…） */
        meta: sourceId => invoke('db:meta', sourceId),
        objects: (sourceId, category) => invoke('db:objects', { sourceId, category }),
        ddl: (sourceId, category, name) => invoke('db:ddl', { sourceId, category, name }),
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

    /** 安全运维 · 网络安全：请求构造重放（Postman 类）+ 本地抓包代理（Burp 类） */
    netsec: {
        send: payload => invoke('netsec:send', payload),
        proxy: {
            start: options => invoke('netsec:proxy:start', options),
            stop: () => invoke('netsec:proxy:stop'),
            status: () => invoke('netsec:proxy:status')
        },
        decision: payload => invoke('netsec:decision', payload),
        cases: {
            list: () => invoke('netsec:cases:list'),
            save: payload => invoke('netsec:case:save', payload),
            remove: id => invoke('netsec:case:delete', id)
        },
        history: (limit = 200) => invoke('netsec:history:list', limit),
        clearHistory: () => invoke('netsec:history:clear'),
        /** 抓包流水推送（主进程 → 渲染进程） */
        onPacket: callback => {
            if (demoMode || typeof bridge.on !== 'function') return () => {};
            return bridge.on('netsec:packet', callback);
        },
        /** 断点暂停请求推送 */
        onBreakpoint: callback => {
            if (demoMode || typeof bridge.on !== 'function') return () => {};
            return bridge.on('netsec:breakpoint', callback);
        }
    },

    /** 安全运维 · 信息安全：哈希 / 对称加解密 / HMAC·PBKDF2 / 压缩 / RSA / JWT / 二维码（本机计算） */
    sec: {
        hash: payload => invoke('sec:hash', payload),
        cipher: payload => invoke('sec:cipher', payload),
        ciphers: () => invoke('sec:ciphers'),
        hmac: payload => invoke('sec:hmac', payload),
        pbkdf2: payload => invoke('sec:pbkdf2', payload),
        codec: payload => invoke('sec:codec', payload),
        rsa: payload => invoke('sec:rsa', payload),
        jwt: payload => invoke('sec:jwt', payload),
        qr: {
            generate: payload => invoke('sec:qr:generate', payload),
            decode: payload => invoke('sec:qr:decode', payload)
        },
        drivers: () => invoke('sec:drivers')
    },

    /** AI 助手：模型 / Agent / 对话 / 会话管理 / 脚本生成与优化 */
    ai: {
        config: {
            get: () => invoke('ai:config:get'),
            save: payload => invoke('ai:config:save', payload)
        },
        test: model => invoke('ai:test', { model }),
        chat: (messages, agent = false, role = '') => invoke('ai:chat', { messages, agent, role }),
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
        /** 提示词角色：清单 / 管理员保存删除 / 用户默认角色选择 */
        roles: {
            list: () => invoke('ai:roles:list'),
            save: payload => invoke('ai:roles:save', payload),
            remove: id => invoke('ai:roles:delete', id),
            select: roleId => invoke('ai:role:save', { roleId })
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
