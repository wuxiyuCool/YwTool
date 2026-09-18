/**
 * 演示数据（仅用于浏览器直接打开页面时占位）
 * Electron 中运行时不会走到这里：数据全部来自主进程 IPC
 */

export const demoHosts = [
    { id: 'h_01', name: 'app-server-01', ip: '10.0.12.11', port: 22, user: 'root', authType: 'key', tags: ['生产', '应用'], status: 'online', lastConnectedAt: '2026-09-16 14:02' },
    { id: 'h_02', name: 'app-server-02', ip: '10.0.12.12', port: 22, user: 'root', authType: 'key', tags: ['生产', '应用'], status: 'online', lastConnectedAt: '2026-09-16 14:02' },
    { id: 'h_03', name: 'web-server-01', ip: '10.0.12.21', port: 22, user: 'deploy', authType: 'key', tags: ['生产', 'Web'], status: 'unknown', lastConnectedAt: '2026-09-16 13:40' },
    { id: 'h_04', name: 'db-server-01', ip: '10.0.20.31', port: 22, user: 'oracle', authType: 'password', tags: ['生产', '数据库'], status: 'unknown', lastConnectedAt: '2026-09-16 11:40' },
    { id: 'h_05', name: 'db-server-02', ip: '10.0.20.32', port: 22, user: 'oracle', authType: 'password', tags: ['生产', '数据库'], status: 'offline', lastConnectedAt: '2026-09-15 22:10' },
    { id: 'h_06', name: 'bigdata-node-01', ip: '10.0.30.41', port: 22, user: 'root', authType: 'key', tags: ['大数据'], status: 'unknown', lastConnectedAt: '2026-09-16 10:15' },
    { id: 'h_07', name: 'bigdata-node-02', ip: '10.0.30.42', port: 22, user: 'root', authType: 'key', tags: ['大数据'], status: 'unknown', lastConnectedAt: '2026-09-16 10:15' },
    { id: 'h_08', name: 'test-server-01', ip: '192.168.5.11', port: 22, user: 'root', authType: 'password', tags: ['测试'], status: 'unknown', lastConnectedAt: '2026-09-16 09:31' }
];

export const demoScripts = [
    { id: 's_01', name: 'check_disk.sh', type: 'shell', desc: '磁盘使用率巡检，超 85% 告警', version: 'v3', author: 'admin', updatedAt: '2026-09-12 10:20' },
    { id: 's_02', name: 'clean_logs.sh', type: 'shell', desc: '清理 7 天前的历史日志', version: 'v5', author: 'admin', updatedAt: '2026-09-10 15:02' },
    { id: 's_03', name: 'sync_config.sh', type: 'shell', desc: '从配置中心拉取并分发配置', version: 'v2', author: 'ops01', updatedAt: '2026-09-08 09:41' },
    { id: 's_04', name: 'update_cert.py', type: 'python', desc: '批量续期 HTTPS 证书并 reload nginx', version: 'v1.3', author: 'admin', updatedAt: '2026-09-16 09:47' },
    { id: 's_05', name: 'reset_password.py', type: 'python', desc: '第三方系统模拟登录重置密码', version: 'v2.1', author: 'admin', updatedAt: '2026-09-14 11:05' }
];

export const demoRules = [
    { id: 'r_01', pattern: 'rm\\s+-rf\\s+/', desc: '递归强制删除根路径', level: '高危', mode: 'blacklist', enabled: true, hits: 6 },
    { id: 'r_02', pattern: 'mkfs', desc: '格式化文件系统', level: '高危', mode: 'blacklist', enabled: true, hits: 0 },
    { id: 'r_03', pattern: 'dd\\s+if=.*of=/dev/', desc: '覆写磁盘设备', level: '高危', mode: 'blacklist', enabled: true, hits: 0 },
    { id: 'r_04', pattern: ':\\(\\)\\s*\\{.*\\};\\s*:', desc: 'Fork 炸弹', level: '高危', mode: 'blacklist', enabled: true, hits: 1 },
    { id: 'r_05', pattern: 'shutdown|reboot', desc: '关机 / 重启服务器', level: '中危', mode: 'blacklist', enabled: true, hits: 2 },
    { id: 'r_06', pattern: 'userdel|groupdel', desc: '删除用户 / 用户组', level: '中危', mode: 'blacklist', enabled: true, hits: 0 },
    { id: 'r_07', pattern: 'iptables\\s+-F', desc: '清空防火墙规则', level: '中危', mode: 'blacklist', enabled: true, hits: 0 },
    { id: 'r_08', pattern: '^df -h$', desc: '磁盘查看（白名单免校验）', level: '低危', mode: 'whitelist', enabled: true, hits: 41 },
    { id: 'r_09', pattern: '^systemctl status .+', desc: '服务状态查询（白名单免校验）', level: '低危', mode: 'whitelist', enabled: true, hits: 28 },
    { id: 'r_10', pattern: '^ls .*', desc: '目录浏览（白名单免校验）', level: '低危', mode: 'whitelist', enabled: false, hits: 15 }
];

export const demoAccounts = [
    { id: 'a_01', name: '堡垒机系统', url: 'https://bastion.corp.local', user: 'svc_ops', scriptName: 'login_bastion.py', status: 'ok', lastSyncAt: '2026-09-16 08:00', passwordMasked: '●●●●●●●●' },
    { id: 'a_02', name: 'OA 办公系统', url: 'https://oa.corp.local', user: 'svc_admin', scriptName: 'login_oa.py', status: 'ok', lastSyncAt: '2026-09-15 18:30', passwordMasked: '●●●●●●●●' },
    { id: 'a_03', name: '邮件系统', url: 'https://mail.corp.local', user: 'svc_mail', scriptName: 'login_mail.py', status: 'expired', lastSyncAt: '2026-09-14 10:00', passwordMasked: '●●●●●●●●' },
    { id: 'a_04', name: '财务共享平台', url: 'https://fin.corp.local', user: 'svc_fin', scriptName: 'login_fin.py', status: 'ok', lastSyncAt: '2026-09-16 06:00', passwordMasked: '●●●●●●●●' },
    { id: 'a_05', name: '监控平台', url: 'https://zabbix.corp.local', user: 'svc_monitor', scriptName: 'login_zabbix.py', status: 'error', lastSyncAt: '2026-09-10 09:00', passwordMasked: '●●●●●●●●' }
];

export const demoTasks = [
    { id: 'T-20260916-0031', cmd: 'df -h', hostCount: 12, status: 'running', operator: 'admin', createdAt: '2026-09-16 14:02:11', successCount: 9, failedCount: 0 },
    { id: 'T-20260916-0030', cmd: 'find /var/log -mtime +7 -delete', hostCount: 8, status: 'success', operator: 'admin', createdAt: '2026-09-16 11:40:02', successCount: 8, failedCount: 0 },
    { id: 'T-20260916-0029', cmd: 'systemctl restart nginx', hostCount: 3, status: 'success', operator: 'ops01', createdAt: '2026-09-16 10:15:33', successCount: 3, failedCount: 0 },
    { id: 'T-20260916-0028', cmd: 'rm -rf /var/log', hostCount: 16, status: 'blocked', operator: 'ops01', createdAt: '2026-09-16 09:31:20', successCount: 0, failedCount: 0 },
    { id: 'T-20260915-0047', cmd: 'sysctl -p', hostCount: 26, status: 'failed', operator: 'admin', createdAt: '2026-09-15 17:22:45', successCount: 23, failedCount: 3 }
];

export const demoLogs = [
    { time: '2026-09-16 13:58:02', type: '拦截', level: 'danger', user: 'ops01', source: '本机', detail: '命令 "rm -rf /var/log" 命中 1 条敏感规则：[高危] 递归强制删除根路径', result: 'blocked' },
    { time: '2026-09-16 13:12:31', type: '告警', level: 'warn', user: 'system', source: '-', detail: 'db-server-02 SSH 连接超时，重试 2 次失败', result: 'failed' },
    { time: '2026-09-16 11:40:02', type: '命令', level: 'info', user: 'admin', source: '本机', detail: 'T-20260916-0030 在 8 台主机执行 find /var/log -mtime +7 -delete（成功 8 / 失败 0）', result: 'success' },
    { time: '2026-09-16 10:15:33', type: '命令', level: 'info', user: 'ops01', source: '本机', detail: 'T-20260916-0029 在 3 台主机执行 systemctl restart nginx（成功 3 / 失败 0）', result: 'success' },
    { time: '2026-09-16 09:47:10', type: '操作', level: 'info', user: 'admin', source: '本机', detail: '更新脚本 update_cert.py（v1.3）', result: 'success' },
    { time: '2026-09-16 08:00:00', type: '登录', level: 'info', user: 'admin', source: '本机', detail: '模拟登录「堡垒机系统」：成功', result: 'success' },
    { time: '2026-09-15 17:22:45', type: '命令', level: 'info', user: 'admin', source: '本机', detail: 'T-20260915-0047 在 26 台主机执行 sysctl -p（成功 23 / 失败 3）', result: 'failed' }
];

export const demoUsers = [
    { id: 'u_01', username: 'admin', role: '系统管理员', enabled: true, lastLoginAt: '2026-09-16 09:12' },
    { id: 'u_02', username: 'ops01', role: '运维员', enabled: true, lastLoginAt: '2026-09-16 13:05' },
    { id: 'u_03', username: 'auditor01', role: '审计员', enabled: true, lastLoginAt: '2026-09-15 16:40' },
    { id: 'u_04', username: 'ops02', role: '运维员', enabled: false, lastLoginAt: '2026-08-30 10:12' }
];

export const demoDbSources = [
    { id: 'd_01', type: 'oracle', name: 'Oracle（生产库）', host: '10.0.20.31', port: 1521, database: 'orcl', user: 'system', status: 'configured', note: '连接池 8', enabled: true, tags: ['生产', 'Oracle'], hasPassword: true, passwordMasked: '●●●●●●●●', lastTestAt: '2026-09-16 11:00:12', lastTestOk: true, driverReady: false },
    { id: 'd_02', type: 'mysql', name: 'MySQL（业务库）', host: '', port: 3306, database: '', user: '', status: 'unconfigured', note: '', enabled: true, tags: ['业务', 'MySQL'], hasPassword: false, passwordMasked: '', lastTestAt: null, lastTestOk: null, driverReady: false },
    { id: 'd_03', type: 'postgres', name: 'PostgreSQL', host: '', port: 5432, database: '', user: '', status: 'pending', note: '驱动接口已预留，待后续版本接入', enabled: false, tags: ['预留'], hasPassword: false, passwordMasked: '', lastTestAt: null, lastTestOk: null, driverReady: false }
];

export const demoDriverMeta = {
    drivers: { mysql: false, oracle: false, postgres: false },
    hints: {
        mysql: '未安装 mysql2 依赖，请先执行：npm install mysql2',
        oracle: '未安装 oracledb 依赖，请先执行：npm install oracledb（需 Oracle Instant Client）',
        postgres: '未安装 pg 依赖，请先执行：npm install pg'
    },
    types: [
        { id: 'mysql', label: 'MySQL', port: 3306, driver: 'mysql2', available: true },
        { id: 'oracle', label: 'Oracle', port: 1521, driver: 'oracledb', available: true },
        { id: 'postgres', label: 'PostgreSQL', port: 5432, driver: 'pg', available: false, note: '驱动接口已预留，待后续版本接入' }
    ]
};

/* ---------------- 模块与权限（演示数据，与主进程 permissions.js 保持一致） ---------------- */

export const demoDomains = [
    { id: 'server', label: '服务器运维', desc: '主机资产 · 批量命令 · 脚本托管' },
    { id: 'database', label: '数据库运维', desc: '数据源配置 · SQL 工作台' },
    { id: 'system', label: '系统运维', desc: '用户权限 · 安全规则 · 审计告警 · 运行参数' }
];

export const demoModules = [
    { id: 'dashboard', domain: 'server', label: '总览', desc: '平台运行概览与近期动态', pages: ['dashboard'], caps: ['viewer'] },
    { id: 'hosts', domain: 'server', label: '主机管理', desc: '内网主机资产与 SSH 连接', pages: ['hosts'], caps: ['viewer', 'operator', 'admin'] },
    { id: 'tasks', domain: 'server', label: '任务执行', desc: '批量命令执行与历史', pages: ['tasks'], caps: ['viewer', 'operator', 'admin'] },
    { id: 'scripts', domain: 'server', label: '脚本管理', desc: 'Shell / Python 脚本托管', pages: ['scripts'], caps: ['viewer', 'operator', 'admin'] },
    { id: 'schedules', domain: 'server', label: '定时任务', desc: '周期任务编排（并入任务页）', pages: [], caps: ['viewer', 'operator', 'admin'] },
    { id: 'dbconfig', domain: 'database', label: '数据库配置', desc: '数据源增删改查与连接测试', pages: ['dbconfig'], caps: ['viewer', 'operator', 'admin'] },
    { id: 'sqltools', domain: 'database', label: 'SQL 工作台', desc: '库表结构浏览与 SQL 执行', pages: ['sql'], caps: ['viewer', 'operator', 'admin'] },
    { id: 'accounts', domain: 'system', label: '多系统账号', desc: '第三方系统凭据与模拟登录', pages: ['accounts'], caps: ['viewer', 'operator', 'admin'] },
    { id: 'rules', domain: 'system', label: '敏感词配置', desc: '命令拦截规则与白名单', pages: ['sensitive'], caps: ['viewer', 'admin'] },
    { id: 'audit', domain: 'system', label: '日志审计', desc: '操作留痕与异常告警', pages: ['audit'], caps: ['viewer', 'admin'] },
    { id: 'alerts', domain: 'system', label: '告警中心', desc: '顶栏告警铃铛与确认', pages: [], caps: ['viewer', 'operator', 'admin'] },
    { id: 'users', domain: 'system', label: '用户与权限', desc: '账号、角色与模块权限矩阵', pages: [], caps: ['viewer', 'admin'] },
    { id: 'settings', domain: 'system', label: '系统设置', desc: '运行参数与依赖状态', pages: ['system'], caps: ['viewer', 'admin'] },
    { id: 'ai', domain: 'system', label: 'AI 助手', desc: 'AI 对话 · 脚本生成与优化', pages: [], caps: ['viewer', 'operator', 'admin'] }
];

const ALL_ADMIN = demoModules.reduce((acc, m) => { acc[m.id] = 'admin'; return acc; }, {});

export const demoModuleMeta = {
    modules: demoModules,
    domains: demoDomains,
    levels: ['viewer', 'operator', 'admin'],
    levelLabels: { viewer: '只读', operator: '可操作', admin: '可管理' },
    roleDefaults: {
        '系统管理员': ALL_ADMIN,
        '运维员': {
            dashboard: 'viewer', hosts: 'operator', tasks: 'operator', scripts: 'operator', schedules: 'operator',
            dbconfig: 'viewer', sqltools: 'operator', accounts: 'operator', rules: 'viewer', audit: 'viewer',
            alerts: 'operator', ai: 'operator', users: null, settings: null
        },
        '审计员': {
            dashboard: 'viewer', hosts: 'viewer', tasks: 'viewer', scripts: 'viewer', schedules: 'viewer',
            dbconfig: 'viewer', sqltools: 'viewer', accounts: 'viewer', rules: 'viewer', audit: 'viewer',
            alerts: 'viewer', users: null, settings: null
        }
    }
};

export const demoPerms = {
    ok: true,
    modulePermEnabled: true,
    roles: demoModuleMeta.roleDefaults,
    users: demoUsers.map(u => ({
        id: u.id, username: u.username, role: u.role, enabled: u.enabled,
        override: false,
        modules: demoModuleMeta.roleDefaults[u.role] || {}
    }))
};

/* ---------------- 应用菜单栏结构（演示数据，与主进程 menuModel.js 保持一致） ---------------- */

export const demoMenuModel = {
    DOMAINS: demoDomains.map(d => ({ id: d.id, label: d.label })),
    PAGES: demoModules.flatMap(m => m.pages.map(p => ({ id: p, domain: m.domain, module: m.id })))
        .map(p => ({ ...p, label: {
            dashboard: '总览', hosts: '主机管理', tasks: '任务执行', scripts: '脚本管理',
            dbconfig: '数据库配置', sql: 'SQL 工作台', accounts: '多系统账号',
            sensitive: '敏感词配置', audit: '日志审计', system: '系统设置'
        }[p.id] || p.id })),
    DOMAIN_LABEL: demoDomains.reduce((acc, d) => { acc[d.id] = d.label; return acc; }, {}),
    PAGE_LABEL: demoModules.flatMap(m => m.pages.map(p => ({ id: p, label: p }))).reduce((acc, p) => { acc[p.id] = p.label; return acc; }, {}),
    PAGE_MODULE: demoModules.flatMap(m => m.pages.map(p => ({ id: p, module: m.id }))).reduce((acc, p) => { acc[p.id] = p.module; return acc; }, {})
};

export const demoSchedules = [
    { id: 'sc_01', name: '每日磁盘巡检', mode: 'daily', time: '08:30', cmd: 'df -h', scriptId: null, hostIds: ['h_01', 'h_02', 'h_03'], concurrency: 5, timeout: 30, enabled: true, nextRunText: '2026-09-17 08:30', scheduleText: '每日 08:30', lastRunAt: '2026-09-16 08:30:01', lastStatus: 'success' },
    { id: 'sc_02', name: '每 30 分钟日志清理', mode: 'interval', intervalMinutes: 30, cmd: '', scriptId: 's_02', hostIds: ['h_01', 'h_02'], concurrency: 3, timeout: 60, enabled: false, nextRunText: '-', scheduleText: '每 30 分钟', lastRunAt: null, lastStatus: null }
];

export const demoConfig = {
    maxConcurrency: 10,
    cmdTimeout: 30,
    highRiskAction: 'block',
    whitelistEnabled: true,
    logRetentionDays: 180,
    alertMode: 'ui',
    currentUser: 'admin',
    resetPolicy: { length: 16, charset: 'full', afterReset: 'verify' }
};

export const demoEnv = {
    dataFile: '%APPDATA%/wxytool/data/sgops.json',
    logDir: '%APPDATA%/wxytool/logs',
    todayLog: '%APPDATA%/wxytool/logs/audit-2026-09-16.log',
    drivers: { ssh2: false, mysql2: false, oracledb: false, pg: false },
    hints: {}
};

/* ---------------- AI 助手（演示数据） ---------------- */

export const demoAiConfig = {
    ok: true,
    config: {
        provider: 'deepseek',
        baseURL: 'https://api.deepseek.com',
        model: 'deepseek-chat',
        hasKey: true,
        providers: [
            { id: 'deepseek', label: 'DeepSeek 深度求索', baseURL: 'https://api.deepseek.com', model: 'deepseek-chat', models: ['deepseek-chat', 'deepseek-reasoner'] },
            { id: 'qwen', label: '通义千问（阿里云百炼）', baseURL: 'https://dashscope.aliyuncs.com/compatible-mode/v1', model: 'qwen-plus', models: ['qwen-turbo', 'qwen-plus', 'qwen-max'] },
            { id: 'kimi', label: 'Kimi（Moonshot）', baseURL: 'https://api.moonshot.cn/v1', model: 'moonshot-v1-8k', models: ['moonshot-v1-8k', 'moonshot-v1-32k'] },
            { id: 'ollama', label: 'Ollama（本地私有化）', baseURL: 'http://localhost:11434/v1', model: 'llama3.1', models: ['llama3.1', 'qwen2.5'] },
            { id: 'custom', label: '自定义（OpenAI 兼容）', baseURL: '', model: '', models: [] }
        ]
    }
};

/** Agent 全局能力配置（演示） */
export const demoAiAgentConfig = {
    enabled: false,
    maxSteps: 6,
    allowDataGenerate: true,
    allowSaveScript: true,
    allowLocalExec: false,
    allowSqlExecute: false,
    commandTimeout: 15,
    maxRows: 200
};

/** Agent 工具清单（演示，与主进程 agentTools.js 保持一致） */
export const demoAiTools = [
    { name: 'list_hosts', label: '查询主机清单', desc: '查询平台内的主机资产清单（名称/IP/登录用户/状态/标签），不含任何凭据', risk: '只读', gate: null },
    { name: 'list_db_sources', label: '查询数据源清单', desc: '列出已配置且启用的数据源（id / 名称 / 类型 / 地址），不含账号密码', risk: '只读', gate: null },
    { name: 'generate_data', label: '生成测试数据', desc: '按字段定义生成结构化测试数据，支持 json / csv / sql 三种输出格式，数据只在本机合成', risk: '低危', gate: 'allowDataGenerate' },
    { name: 'save_script', label: '保存为脚本', desc: '把生成的 Shell / Python 脚本保存到平台的「脚本管理」模块（同名脚本自动升版本号）', risk: '中危', gate: 'allowSaveScript' },
    { name: 'run_local_command', label: '执行本机命令', desc: '在运行本平台的这台机器上执行一条 Shell 命令并返回输出；受敏感词规则与安全开关约束', risk: '高危', gate: 'allowLocalExec' },
    { name: 'execute_sql', label: '查询数据源', desc: '在已配置的数据源上执行只读 SQL（仅 SELECT / SHOW / DESC / EXPLAIN），返回前若干行结果', risk: '高危', gate: 'allowSqlExecute' }
];

/* ---------------- 数据集成（ETL）演示数据 ---------------- */

export const demoEtlTasks = [
    {
        id: 'et_01', name: 'MySQL 主机表 → Oracle 资产表', author: 'admin', updatedAt: '2026-09-18 10:20',
        source: { kind: 'db', sourceId: 'd_02', table: 'app_host', columns: '', where: '' },
        target: { kind: 'db', sourceId: 'd_01', table: 'OPS_ASSET', mode: 'upsert', keyColumns: ['ID'] },
        mapping: [
            { from: 'id', to: 'ID', transform: 'integer' },
            { from: 'host_name', to: 'NAME', transform: 'trim' },
            { from: 'status', to: 'STATUS', transform: 'upper' },
            { from: null, to: 'SOURCE', transform: 'const', default: 'sgops-sync' }
        ],
        options: { batchSize: 500, limit: 50000, emptyAsNull: true }
    },
    {
        id: 'et_02', name: '巡检结果 CSV → 业务库', author: 'admin', updatedAt: '2026-09-17 18:02',
        source: { kind: 'file', filePath: 'D:/data/inspect_20260917.csv', format: 'csv', hasHeader: true },
        target: { kind: 'db', sourceId: 'd_02', table: 'inspect_log', mode: 'insert', keyColumns: [] },
        mapping: [
            { from: 'host', to: 'host_name', transform: 'trim' },
            { from: 'usage', to: 'disk_usage', transform: 'number' },
            { from: 'checked_at', to: 'checked_at', transform: 'date' }
        ],
        options: { batchSize: 500, limit: 50000, emptyAsNull: true }
    }
];

export const demoEtlRuns = [
    {
        id: 'r_01', name: 'MySQL 主机表 → Oracle 资产表', sourceKind: 'db', targetKind: 'db',
        targetTable: 'OPS_ASSET', mode: 'upsert', modeLabel: '更新插入',
        read: 1280, written: 1280, failed: 0, batches: 3, durationMs: 4210,
        user: 'admin', createdAt: '2026-09-18 10:22:11'
    },
    {
        id: 'r_02', name: '巡检结果 CSV → 业务库', sourceKind: 'file', targetKind: 'db',
        targetTable: 'inspect_log', mode: 'insert', modeLabel: '追加',
        read: 96, written: 90, failed: 6, batches: 1, durationMs: 780,
        user: 'admin', createdAt: '2026-09-17 18:03:40',
        errors: [{ batch: 1, rows: 6, message: "Data too long for column 'host_name' at row 12" }]
    }
];

export const demoAiHistory = {
    ok: true,
    messages: [
        { role: 'assistant', content: '你好，我是 SgOps 运维助手。可以问我服务器巡检、脚本编写、数据库运维等问题，也可以为你生成或优化运维脚本。', at: '2026-09-18 09:00:00' }
    ]
};

export const demoAiScript = {
    ok: true,
    script: '#!/bin/bash\n# 磁盘使用率巡检（演示）\nTHRESHOLD=${THRESHOLD:-85}\nUSED=$(df -h / | awk \'NR==2 {print $5}\' | tr -d \'%\')\nif [ "$USED" -ge "$THRESHOLD" ]; then\n  echo "[WARN] 根分区使用率 ${USED}%" >&2\n  exit 1\nfi\necho "[OK] 根分区使用率 ${USED}%"',
    explanation: '说明：\n1. 阈值可通过 THRESHOLD 环境变量覆盖。\n2. 告警走 stderr，便于与正常输出区分。',
    type: 'Shell',
    durationMs: 1200
};

/* ---------------- SQL 工作台（演示数据） ---------------- */

export const demoSqlScripts = [
    {
        id: 'sq_01', name: '慢查询 Top 10', sourceId: 'd_02',
        sql: "SELECT id, user, host, db, command, time, state, info\nFROM information_schema.processlist\nWHERE command <> 'Sleep'\nORDER BY time DESC\nLIMIT 10;",
        author: 'admin', createdAt: '2026-09-16 10:00', updatedAt: '2026-09-16 10:00'
    },
    {
        id: 'sq_02', name: '表容量概览', sourceId: 'd_02',
        sql: 'SELECT table_name, table_rows,\n       ROUND(data_length / 1024 / 1024, 2) AS data_mb,\n       ROUND(index_length / 1024 / 1024, 2) AS index_mb\nFROM information_schema.tables\nWHERE table_schema = DATABASE()\nORDER BY data_length DESC\nLIMIT 50;',
        author: 'admin', createdAt: '2026-09-16 10:05', updatedAt: '2026-09-16 10:05'
    },
    {
        id: 'sq_03', name: '会话与锁等待排查', sourceId: 'd_01',
        sql: "SELECT s.sid, s.serial#, s.username, s.status, s.sql_id\nFROM v$session s\nWHERE s.status = 'ACTIVE'\nORDER BY s.sid;",
        author: 'ops01', createdAt: '2026-09-15 16:20', updatedAt: '2026-09-15 16:20'
    }
];

export const demoSqlColumns = ['table_name', 'table_rows', 'data_mb', 'index_mb'];

export const demoSqlRows = [
    { table_name: 't_order_detail', table_rows: 8421330, data_mb: 2140.55, index_mb: 620.18 },
    { table_name: 't_order', table_rows: 2104988, data_mb: 812.4, index_mb: 288.06 },
    { table_name: 't_user_login_log', table_rows: 19402331, data_mb: 640.12, index_mb: 410.77 },
    { table_name: 't_config_item', table_rows: 1284, data_mb: 2.31, index_mb: 0.45 },
    { table_name: 't_sync_job', table_rows: 396, data_mb: 0.88, index_mb: 0.12 }
];

export const demoSqlHistory = [
    { id: 'q_03', sourceName: 'MySQL（业务库）', type: 'mysql', user: 'admin', sql: 'SELECT table_name, table_rows FROM information_schema.tables LIMIT 50', result: 'success', statementCount: 1, durationMs: 26, rowCount: 5, createdAt: '2026-09-16 13:40:12' },
    { id: 'q_02', sourceName: 'Oracle（生产库）', type: 'oracle', user: 'admin', sql: "SELECT s.sid, s.username FROM v$session s WHERE s.status = 'ACTIVE'", result: 'success', statementCount: 1, durationMs: 88, rowCount: 12, createdAt: '2026-09-16 11:02:45' },
    { id: 'q_01', sourceName: 'MySQL（业务库）', type: 'mysql', user: 'ops01', sql: 'DROP DATABASE bizdb', result: 'blocked', statementCount: 1, durationMs: 0, rowCount: 0, createdAt: '2026-09-16 09:20:03' }
];

export function demoDbTables(sourceId) {
    if (sourceId === 'd_01') {
        return { ok: true, tables: [{ name: 'V$SESSION', comment: '动态性能视图' }, { name: 'T_ORDER', comment: '订单主表' }, { name: 'T_USER', comment: '用户表' }, { name: 'T_CONFIG_ITEM', comment: '配置项' }] };
    }
    return {
        ok: true,
        tables: [
            { name: 't_order', comment: '订单主表' },
            { name: 't_order_detail', comment: '订单明细' },
            { name: 't_user', comment: '用户表' },
            { name: 't_user_login_log', comment: '登录日志' },
            { name: 't_config_item', comment: '配置项' },
            { name: 't_sync_job', comment: '同步任务' }
        ]
    };
}

export function demoDbDescribe(data) {
    const table = (data && data.table) || 't_order';
    return {
        ok: true, table,
        columns: [
            { name: 'id', type: 'bigint(20)', nullable: 'NO', key: 'PRI', default: null, extra: 'auto_increment' },
            { name: 'order_no', type: 'varchar(64)', nullable: 'NO', key: 'UNI', default: null, extra: '' },
            { name: 'user_id', type: 'bigint(20)', nullable: 'NO', key: 'MUL', default: null, extra: '' },
            { name: 'amount', type: 'decimal(18,2)', nullable: 'NO', key: '', default: '0.00', extra: '' },
            { name: 'status', type: 'tinyint(4)', nullable: 'NO', key: '', default: '0', extra: '' },
            { name: 'created_at', type: 'datetime', nullable: 'NO', key: 'MUL', default: 'CURRENT_TIMESTAMP', extra: '' }
        ]
    };
}

export function demoDbSchema(sourceId) {
    const r = demoDbTables(sourceId);
    return {
        ok: true,
        groups: r.tables.map(t => ({ name: t.name, comment: t.comment, columns: demoDbDescribe({ table: t.name }).columns }))
    };
}
