/**
 * 权限管理模块
 * - 用户口令：scrypt 单向哈希（crypto.hashPassword / verifyPassword）
 * - 会话：进程内多会话（本地单机部署），登录后记录 username / role / loginAt
 * - 鉴权：三层校验，由 index.js 统一包装所有 handler（业务代码零侵入）
 *     1) 通道分类（read / write / admin）→ 角色能力 ROLE_CAPS
 *     2) 模块可见性 → 用户可访问的功能模块（含界面菜单）
 *     3) 模块内角色 → viewer / operator / admin
 */
const store = require('./store');
const audit = require('./auditLogger');
const perms = require('./permissions');
const { hashPassword, verifyPassword } = require('./crypto');

/** 角色 → 能力 */
const ROLE_CAPS = {
    '系统管理员': { read: true, write: true, admin: true },
    '运维员': { read: true, write: true, admin: false },
    '审计员': { read: true, write: false, admin: false }
};

/** 公开通道：无需登录 */
const PUBLIC_CHANNELS = new Set(['app:info', 'auth:login', 'auth:session', 'auth:logout']);

/** 管理员专属通道（角色能力层面的硬约束，模块权限无法突破） */
const ADMIN_ONLY = new Set([
    'system:config:save',
    'system:users:save', 'system:users:delete',
    'system:perms:save', 'system:perms:reset',
    // 配置备份包含凭据明文（信封内），导入会整库覆写：仅系统管理员
    'system:backup:export', 'system:backup:import',
    'system:secrets:status', 'system:secrets:template', 'system:secrets:encrypt',
    // 凭据台账：列表与解密查看均仅系统管理员
    'ledger:list', 'ledger:reveal', 'ledger:unlock', 'ledger:lock', 'ledger:status',
    // 容器运维：端点凭据管理与容器内命令、本机 compose 属高危
    'docker:host:save', 'docker:host:delete', 'docker:exec', 'docker:compose:run',
    // K8s：集群配置与任意 kubectl 执行仅管理员（只读概览随 containers 模块授权）
    'kube:cluster:save', 'kube:cluster:delete', 'kube:run',
    'accounts:reveal', 'accounts:policy:save', 'accounts:save', 'accounts:delete',
    'rules:save', 'rules:delete', 'rules:toggle',
    'audit:cleanup',
    'alerts:clear',
    'auth:resetPassword',
    'schedules:save', 'schedules:delete', 'schedules:toggle',
    'sql:execute', 'db:tables', 'db:describe', 'db:schema', 'sql:export',
    'db:meta', 'db:objects', 'db:ddl',
    'sqlScripts:save', 'sqlScripts:delete',
    'dbconfig:save', 'dbconfig:delete', 'dbconfig:import',
    'ai:config:save', 'ai:test',
    // 提示词角色定义属平台级配置（会话/权限不受影响），仅管理员维护
    'ai:roles:save', 'ai:roles:delete',
    // 数据集成（ETL）：批量写库与数据外流均属高危，仅管理员
    'db:etl:run', 'db:etl:tasks:save', 'db:etl:tasks:delete',
    // 网络安全工作台：外发请求 / 代理 / 断点改包均属高危操作，仅管理员
    'netsec:send', 'netsec:proxy:start', 'netsec:proxy:stop', 'netsec:decision',
    'netsec:case:save', 'netsec:case:delete', 'netsec:history:clear',
    // 二维码解码会加载本地图片文件，生成可外发内容：按写操作对待，仅管理员
    'sec:qr:decode',
    // Agent 全局能力配置属高危：只有管理员能放开「本机命令 / SQL 执行」等开关
    'ai:agent:save'
]);

const WRITE_PATTERN = /:(save|delete|toggle|run|runNow|exec|execOne|reset|reveal|cleanup|append|lint|loginTest|ack|ackAll|test|password|export|import|chat|generate|optimize|clear|new|switch)$/;

/** 会话容器：本地单机部署，按用户名维护，支持多人分别登录（如同时开多个窗口） */
const sessions = new Map();
/** 最近一次登录 / 操作的会话（供审计与业务代码取 currentUser） */
let activeSession = null;

function classify(channel) {
    if (PUBLIC_CHANNELS.has(channel)) return 'public';
    if (ADMIN_ONLY.has(channel)) return 'admin';
    if (WRITE_PATTERN.test(channel)) return 'write';
    return 'read';
}

/* ------------------------------------------------------------------
 * 模块权限解析
 * ------------------------------------------------------------------ */

/**
 * 解析某用户在各模块上的最终权限
 * 优先级：用户级覆写（modulePerms） > 角色级矩阵（db.modulePermissions） > 内置默认值
 * 系统管理员始终全权限，不受矩阵影响（避免把自己锁死）
 * @returns {Object<string, string|null>} 模块 id → viewer|operator|admin|null
 */
function resolveMatrix(user) {
    if (!user) return {};
    if (user.role === '系统管理员') {
        const all = {};
        perms.MODULES.forEach(m => { all[m.id] = 'admin'; });
        return all;
    }

    const config = store.get('config') || {};
    if (config.modulePermEnabled === false) {
        return perms.roleDefaults(user.role);
    }

    // 用户级覆写为完整矩阵（新建用户时由界面写入），有则优先
    if (user.modulePerms && typeof user.modulePerms === 'object') {
        return perms.sanitizeMatrixForRole(user.modulePerms, user.role);
    }

    const matrix = store.get('modulePermissions') || {};
    if (matrix[user.role]) return perms.sanitizeMatrixForRole(matrix[user.role], user.role);

    return perms.roleDefaults(user.role);
}

/** 矩阵 → 可见模块 id 列表 */
const visibleModules = matrix => perms.moduleIds().filter(id => !!matrix[id]);

/** 矩阵 → 可见页面 id 列表（router 据此裁剪侧边栏） */
function visiblePages(matrix) {
    const out = [];
    perms.MODULES.forEach(m => {
        if (matrix[m.id]) m.pages.forEach(p => { if (!out.includes(p)) out.push(p); });
    });
    return out;
}

/** 计算某用户对某模块的权限等级 */
function moduleLevel(user, moduleId) {
    if (!moduleId) return null;
    return resolveMatrix(user)[moduleId] || null;
}

/** 账号 → 用户对象 */
const findUser = username => store.list('users').find(u => u.username === username) || null;

/**
 * 通道鉴权：返回 { ok, code, message }
 * 依次校验：会话 → 角色能力 → 模块可见性 → 模块内角色
 */
function authorize(channel) {
    if (PUBLIC_CHANNELS.has(channel)) return { ok: true };

    const session = getSession();
    if (!session) {
        return { ok: false, code: 'UNAUTHORIZED', message: '会话已失效，请重新登录' };
    }

    const caps = ROLE_CAPS[session.role] || { read: false, write: false, admin: false };
    const kind = classify(channel);

    if (kind === 'admin' && !caps.admin) {
        return { ok: false, code: 'FORBIDDEN', message: `当前角色（${session.role}）无权执行该操作，需系统管理员权限` };
    }
    if (kind === 'write' && !caps.write) {
        return { ok: false, code: 'FORBIDDEN', message: `当前角色（${session.role}）为只读角色，无法执行该操作` };
    }
    if (!caps.read) {
        return { ok: false, code: 'FORBIDDEN', message: `当前角色（${session.role}）无权访问该资源` };
    }

    // ---------- 模块级校验 ----------
    const moduleId = perms.channelModule(channel);
    if (!moduleId) return { ok: true, kind }; // 未登记通道：仅做登录与角色校验

    const user = findUser(session.username);
    const level = resolveMatrix(user)[moduleId] || null;
    const meta = perms.moduleById(moduleId) || { label: moduleId };

    if (!level) {
        return {
            ok: false, code: 'FORBIDDEN',
            message: `当前账号未开通「${meta.label}」模块权限，请联系系统管理员`
        };
    }

    // 管理员专属通道要求该模块具备 admin 等级
    if (kind === 'admin' && level !== 'admin') {
        return {
            ok: false, code: 'FORBIDDEN',
            message: `「${meta.label}」模块当前权限为${perms.LEVEL_LABEL[level]}，无法执行该管理操作`
        };
    }
    // 写操作要求 operator 及以上
    if (kind === 'write' && !perms.atLeast(level, 'operator')) {
        return {
            ok: false, code: 'FORBIDDEN',
            message: `「${meta.label}」模块当前权限为只读，无法执行该操作`
        };
    }

    return { ok: true, kind, module: moduleId, level };
}

/* ------------------------------------------------------------------
 * 会话与登录
 * ------------------------------------------------------------------ */

/** 获取当前会话：优先取最近活跃会话，失效时回退到唯一的在线会话 */
function getSession() {
    if (activeSession && sessions.has(activeSession.username)) return sessions.get(activeSession.username);
    if (activeSession) activeSession = null;
    return sessions.size ? [...sessions.values()][0] : null;
}

function login(username, password) {
    const user = store.list('users').find(u => u.username === String(username || '').trim());

    if (!user) {
        audit.write({ type: '登录', user: username || '-', detail: `登录失败：用户不存在（${username}）`, result: 'failed' });
        return { ok: false, message: '用户名或密码错误' };
    }
    if (!user.enabled) {
        audit.write({ type: '登录', user: user.username, detail: '登录失败：账号已停用', result: 'failed' });
        return { ok: false, message: '账号已停用，请联系管理员' };
    }
    if (!verifyPassword(password, user.password)) {
        audit.write({ type: '登录', user: user.username, detail: '登录失败：口令校验不通过', result: 'failed' });
        return { ok: false, message: '用户名或密码错误' };
    }

    // 模块权限全空 → 登录后无任何可用界面，提前拦下并给出明确提示
    const matrix = resolveMatrix(user);
    if (!perms.countGrants(matrix)) {
        audit.write({ type: '登录', user: user.username, detail: '登录失败：未开通任何模块权限', result: 'failed' });
        return { ok: false, message: '该账号未开通任何模块权限，请联系系统管理员授权' };
    }

    const session = { username: user.username, role: user.role, loginAt: store.nowText() };
    sessions.set(user.username, session);
    activeSession = session;

    user.lastLoginAt = session.loginAt;
    store.persist();

    audit.write({ type: '登录', user: user.username, detail: `登录成功（${user.role}）` });
    return { ok: true, user: publicUser(user), session: { ...session } };
}

function logout() {
    const session = getSession();
    if (session) {
        audit.write({ type: '登录', user: session.username, detail: '退出登录' });
        sessions.delete(session.username);
        activeSession = sessions.size ? [...sessions.values()][sessions.size - 1] : null;
    }
    return { ok: true };
}

function current() {
    const session = getSession();
    if (!session) return { ok: false, loggedIn: false };
    const user = findUser(session.username);
    if (!user) return { ok: false, loggedIn: false };
    // 账号被停用 / 权限被清空 → 会话立即失效
    if (!user.enabled || !perms.countGrants(resolveMatrix(user))) {
        sessions.delete(session.username);
        activeSession = null;
        return { ok: false, loggedIn: false, message: '账号权限已变更，请重新登录' };
    }
    return { ok: true, loggedIn: true, user: publicUser(user), session: { ...session } };
}

/**
 * 对外暴露的用户视图：脱敏 + 注入能力、可见模块与页面
 * 这是前端界面权限裁剪的唯一数据来源
 */
function publicUser(user) {
    const { password, ...rest } = user;
    const matrix = resolveMatrix(user);
    const grants = {};
    perms.moduleIds().forEach(id => { grants[id] = matrix[id] || null; });
    return {
        ...rest,
        hasPassword: !!password,
        caps: ROLE_CAPS[user.role] || { read: false, write: false, admin: false },
        modules: grants,
        visibleModules: visibleModules(matrix),
        visiblePages: visiblePages(matrix),
        modulePermOverride: !!user.modulePerms
    };
}

function changePassword(username, oldPwd, newPwd) {
    const user = findUser(username || (getSession() || {}).username);
    if (!user) return { ok: false, message: '用户不存在' };
    if (!verifyPassword(oldPwd, user.password)) return { ok: false, message: '原密码不正确' };
    if (String(newPwd || '').length < 6) return { ok: false, message: '新密码长度至少 6 位' };

    user.password = hashPassword(newPwd);
    user.mustChangePassword = false;
    store.persist();
    audit.write({ type: '操作', user: user.username, detail: '修改登录口令' });
    return { ok: true, user: publicUser(user) };
}

/** 新增/重置用户口令（管理员操作） */
function setUserPassword(username, newPwd, mustChange = true) {
    const user = findUser(username);
    if (!user) return { ok: false, message: '用户不存在' };
    user.password = hashPassword(newPwd);
    user.mustChangePassword = !!mustChange;
    store.persist();
    return { ok: true };
}

/** 权限变更后清理会话，使新权限立即生效（下次请求重新解析） */
function dropAllSessions(exceptUsername) {
    [...sessions.keys()].forEach(name => { if (name !== exceptUsername) sessions.delete(name); });
    if (activeSession && !sessions.has(activeSession.username)) {
        activeSession = sessions.size ? [...sessions.values()][sessions.size - 1] : null;
    }
}

module.exports = {
    ROLE_CAPS, PUBLIC_CHANNELS, ADMIN_ONLY,
    classify, authorize, login, logout, current,
    changePassword, setUserPassword, hashPassword,
    publicUser, resolveMatrix, visibleModules, visiblePages, moduleLevel,
    getSession, dropAllSessions,
    isAdmin: () => { const s = getSession(); return !!(s && (ROLE_CAPS[s.role] || {}).admin); }
};
