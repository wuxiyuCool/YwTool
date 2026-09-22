/**
 * 模块级权限模型
 * ------------------------------------------------------------------
 * 三层权限体系：
 *   1. 角色能力（ROLE_CAPS，见 auth.js）：read / write / admin，粗粒度兜底
 *   2. 模块可见性（本文件）：用户可访问哪些功能模块（界面菜单 + IPC 通道）
 *   3. 模块内角色（本文件）：对某模块拥有 viewer（只读）/ operator（可写）/ admin（可管理）
 *
 * 设计要点：
 *   - 通道 → 模块 的映射集中在此处维护，新增 IPC 通道只需补一条规则
 *   - 支持尾部通配（`dbconfig:*`）与整体通配（`*`）
 *   - 未命中任何规则的通道视为「公共模块」，仅做登录校验，不做模块校验
 *     这样能避免新增通道时忘记登记导致整块功能不可用
 */

/** 四大运维域 */
const DOMAINS = [
    { id: 'server', label: '服务器运维', desc: '主机资产 · 批量命令 · 脚本托管' },
    { id: 'database', label: '数据库运维', desc: '数据源配置 · SQL 工作台 · 数据集成' },
    { id: 'security', label: '安全运维', desc: '网络安全抓包重放 · 信息安全加解密工具' },
    { id: 'system', label: '系统运维', desc: '用户权限 · 安全规则 · 审计告警 · 运行参数' }
];

/**
 * 功能模块清单
 * id      模块标识，同时用于通道归属与权限矩阵键名
 * domain  所属域（顶部切换标签）
 * pages   该模块包含的前端页面 id（与 router.js 的 pages 键一致）
 * caps    模块内允许申请的角色：viewer / operator / admin
 */
const MODULES = [
    { id: 'dashboard', domain: 'server', label: '总览', desc: '平台运行概览与近期动态', pages: ['dashboard'], caps: ['viewer'] },
    { id: 'hosts', domain: 'server', label: '主机管理', desc: '内网主机资产与 SSH 连接', pages: ['hosts'], caps: ['viewer', 'operator', 'admin'] },
    { id: 'containers', domain: 'server', label: '容器运维', desc: 'Docker 与 K8s 容器编排运维', pages: ['containers'], caps: ['viewer', 'operator', 'admin'] },
    { id: 'tasks', domain: 'server', label: '任务执行', desc: '批量命令执行与历史', pages: ['tasks'], caps: ['viewer', 'operator', 'admin'] },
    { id: 'scripts', domain: 'server', label: '脚本管理', desc: 'Shell / Python 脚本托管', pages: ['scripts'], caps: ['viewer', 'operator', 'admin'] },
    { id: 'schedules', domain: 'server', label: '定时任务', desc: '周期任务编排（并入任务页）', pages: [], caps: ['viewer', 'operator', 'admin'] },

    { id: 'dbconfig', domain: 'database', label: '数据库配置', desc: '数据源增删改查与连接测试', pages: ['dbconfig'], caps: ['viewer', 'operator', 'admin'] },
    { id: 'sqltools', domain: 'database', label: 'SQL 工作台', desc: '库表结构浏览与 SQL 执行', pages: ['sql'], caps: ['viewer', 'operator', 'admin'] },
    { id: 'etl', domain: 'database', label: '数据集成', desc: '库对库 / 文件对库 / 库对文件 同步', pages: ['etl'], caps: ['viewer', 'operator', 'admin'] },

    { id: 'netsec', domain: 'security', label: '网络安全', desc: '请求重放 · 本地抓包代理 · 断点改包', pages: ['netsec'], caps: ['viewer', 'admin'] },
    { id: 'infosec', domain: 'security', label: '信息安全', desc: '哈希 / 加解密 / JWT / 二维码工具箱', pages: ['infosec'], caps: ['viewer', 'operator', 'admin'] },

    { id: 'accounts', domain: 'system', label: '多系统账号', desc: '第三方系统凭据与模拟登录', pages: ['accounts'], caps: ['viewer', 'operator', 'admin'] },
    { id: 'ledger', domain: 'system', label: '凭据台账', desc: '账号口令聚合台账 · 解密查看（仅系统管理员，不参与矩阵授权）', pages: ['ledger'], caps: [] },
    { id: 'rules', domain: 'system', label: '敏感词配置', desc: '命令拦截规则与白名单', pages: ['sensitive'], caps: ['viewer', 'admin'] },
    { id: 'audit', domain: 'system', label: '日志审计', desc: '操作留痕与异常告警', pages: ['audit'], caps: ['viewer', 'admin'] },
    { id: 'alerts', domain: 'system', label: '告警中心', desc: '顶栏告警铃铛与确认', pages: [], caps: ['viewer', 'operator', 'admin'] },
    { id: 'users', domain: 'system', label: '用户与权限', desc: '账号、角色与模块权限矩阵', pages: ['users'], caps: ['viewer', 'admin'] },
    { id: 'backup', domain: 'system', label: '备份与密钥', desc: '加密备份导入导出 · 外置密钥注入', pages: ['backup'], caps: ['viewer', 'admin'] },
    { id: 'settings', domain: 'system', label: '系统设置', desc: '运行参数与依赖状态', pages: ['system'], caps: ['viewer', 'admin'] },
    { id: 'ai', domain: 'system', label: 'AI 助手', desc: 'AI 对话 · 脚本生成与优化', pages: ['aiconfig'], caps: ['viewer', 'operator', 'admin'] }
];

/**
 * 通道 → 模块 映射
 * - `x:*` 表示前缀通配
 * - 未列出的通道不做模块校验（例如 auth:*、app:info）
 */
const CHANNEL_RULES = [
    // 总览
    ['dashboard:*', 'dashboard'],

    // 服务器运维
    ['hosts:*', 'hosts'],
    ['docker:*', 'containers'],
    ['kube:*', 'containers'],
    ['tasks:*', 'tasks'],
    ['scripts:*', 'scripts'],
    ['schedules:*', 'schedules'],

    // 数据库运维
    ['dbconfig:*', 'dbconfig'],
    ['sql:*', 'sqltools'],
    ['db:etl:*', 'etl'],       // 必须先于 db:*，否则 ETL 通道会被划入 sqltools
    ['db:*', 'sqltools'],
    ['sqlScripts:*', 'sqltools'],
    ['sqlHistory:*', 'sqltools'],

    // 安全运维
    ['netsec:*', 'netsec'],
    ['sec:*', 'infosec'],

    // 系统运维
    ['accounts:*', 'accounts'],
    ['ledger:*', 'ledger'],
    ['rules:*', 'rules'],
    ['audit:*', 'audit'],
    ['alerts:*', 'alerts'],
    ['system:users:*', 'users'],
    ['system:perms:*', 'users'],
    ['system:modules:*', 'users'],
    ['system:backup:*', 'backup'],
    ['system:secrets:*', 'backup'],
    ['system:env', 'settings'],
    ['system:config:*', 'settings'],

    // AI 助手
    ['ai:*', 'ai']
];

/** 角色 → 默认模块权限（键为模块 id，值为 viewer / operator / admin） */
const ROLE_MODULE_DEFAULTS = {
    '系统管理员': 'ALL_ADMIN',
    '运维员': {
        dashboard: 'viewer',
        hosts: 'operator',
        containers: 'operator',
        tasks: 'operator',
        scripts: 'operator',
        schedules: 'operator',
        dbconfig: 'viewer',
        sqltools: 'operator',
        etl: 'viewer',
        netsec: 'viewer',
        infosec: 'operator',
        accounts: 'operator',
        ledger: null,
        rules: 'viewer',
        audit: 'viewer',
        alerts: 'operator',
        ai: 'operator',
        users: null,
        backup: null,
        settings: null
    },
    '审计员': {
        dashboard: 'viewer',
        hosts: 'viewer',
        containers: 'viewer',
        tasks: 'viewer',
        scripts: 'viewer',
        schedules: 'viewer',
        dbconfig: 'viewer',
        sqltools: 'viewer',
        etl: null,
        netsec: 'viewer',
        infosec: 'viewer',
        accounts: 'viewer',
        ledger: null,
        rules: 'viewer',
        audit: 'viewer',
        alerts: 'viewer',
        users: null,
        backup: null,
        settings: null
    }
};

const LEVELS = ['viewer', 'operator', 'admin'];
const LEVEL_LABEL = { viewer: '只读', operator: '可操作', admin: '可管理' };
const LEVEL_RANK = { viewer: 1, operator: 2, admin: 3 };

const moduleIds = () => MODULES.map(m => m.id);
const moduleById = id => MODULES.find(m => m.id === id) || null;

/** 通道 → 模块 id（未命中返回 null） */
function channelModule(channel) {
    const name = String(channel || '');
    for (const [pattern, moduleId] of CHANNEL_RULES) {
        if (pattern === '*') return moduleId;
        if (pattern.endsWith(':*')) {
            const prefix = pattern.slice(0, -1); // 保留冒号
            if (name.startsWith(prefix)) return moduleId;
        } else if (name === pattern) {
            return moduleId;
        }
    }
    return null;
}

/** 模块 id → 页面 id 列表 */
function pagesOf(moduleId) {
    const m = moduleById(moduleId);
    return m ? m.pages.slice() : [];
}

/**
 * 角色默认权限矩阵（全部模块，含被禁用的 null）
 * @returns {Object<string, string|null>}
 */
function roleDefaults(role) {
    const preset = ROLE_MODULE_DEFAULTS[role];
    const out = {};
    MODULES.forEach(m => { out[m.id] = null; });
    if (preset === 'ALL_ADMIN') {
        MODULES.forEach(m => { out[m.id] = 'admin'; });
        return out;
    }
    if (preset) {
        Object.keys(preset).forEach(k => { if (k in out) out[k] = preset[k]; });
    }
    return out;
}

/** 规范化矩阵：剔除未知模块、非法取值，保证键完整 */
function sanitizeMatrix(input) {
    const out = {};
    MODULES.forEach(m => {
        const v = input ? input[m.id] : null;
        // 模块允许的角色收敛：只读模块不会被授予可写/可管理
        out[m.id] = LEVELS.includes(v) && m.caps.includes(v) ? v : null;
    });
    return out;
}

/**
 * 角色感知的矩阵规范化
 * 非系统管理员角色不得在「管理敏感模块」上取得 admin 等级
 * —— 否则会绕过 auth.js 的角色能力层（ROLE_CAPS.admin），形成提权路径
 * 敏感模块内的 viewer 不受影响（审计员仍可只读查看系统设置）
 */
const ADMIN_SENSITIVE = new Set(['users', 'settings', 'rules', 'audit', 'dbconfig']);

function sanitizeMatrixForRole(input, role) {
    const matrix = sanitizeMatrix(input);
    if (role === '系统管理员') return matrix;
    ADMIN_SENSITIVE.forEach(id => {
        if (matrix[id] === 'admin') matrix[id] = 'operator';
        // 只读型模块降级为 viewer（模块本身不接受 operator）
        if (matrix[id] === 'operator' && !(moduleById(id) || { caps: [] }).caps.includes('operator')) {
            matrix[id] = 'viewer';
        }
    });
    return matrix;
}

/** 矩阵是否含任意权限 */
const isEmptyMatrix = matrix => !Object.values(matrix || {}).some(Boolean);

/** 汇总矩阵的授权模块数 */
const countGrants = matrix => Object.values(matrix || {}).filter(Boolean).length;

/** 权限等级比较：a 是否不低于 b */
const atLeast = (a, b) => (LEVEL_RANK[a] || 0) >= (LEVEL_RANK[b] || 0);

module.exports = {
    DOMAINS, MODULES, LEVELS, LEVEL_LABEL, LEVEL_RANK, CHANNEL_RULES, ROLE_MODULE_DEFAULTS, ADMIN_SENSITIVE,
    moduleIds, moduleById, channelModule, pagesOf,
    roleDefaults, sanitizeMatrix, sanitizeMatrixForRole,
    isEmptyMatrix, countGrants, atLeast
};
