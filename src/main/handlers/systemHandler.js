/**
 * 系统管理 IPC（系统运维域）
 * 通道：
 *   system:env                       运行环境（数据文件 / 日志目录 / 驱动状态）
 *   system:config:get|save           运行参数
 *   system:users:list|save|delete    用户账号
 *   system:modules:list              模块清单（权限矩阵的表头）
 *   system:perms:get                 角色权限矩阵 + 用户级覆写
 *   system:perms:save                保存角色权限矩阵
 *   system:perms:reset               重置为内置默认
 * 数据源配置已拆分至独立模块 handlers/dbConfigHandler.js（dbconfig:*）
 */
const store = require('../store');
const audit = require('../auditLogger');
const auth = require('../auth');
const perms = require('../permissions');
const dbAdapters = require('../dbAdapters');
const secrets = require('../secrets');
const ssh = require('../ssh');
const { hashPassword } = require('../crypto');

const operator = () => (auth.getSession() || {}).username || (store.get('config') || {}).currentUser || '-';

/** 用户出参：剥离口令，附带模块权限概览 */
function sanitizeUser(user) {
    const { password, ...rest } = user;
    const matrix = auth.resolveMatrix(user);
    return {
        ...rest,
        password: undefined,
        hasPassword: !!password,
        modules: matrix,
        visibleModules: perms.moduleIds().filter(id => !!matrix[id]),
        modulePermOverride: !!user.modulePerms
    };
}

function setup(ipcMain) {
    /** 运行环境信息：数据文件、日志目录、驱动可用性 */
    ipcMain.handle('system:env', () => ({
        dataFile: store.DB_FILE,
        logDir: store.LOG_DIR,
        todayLog: audit.logFilePath(),
        drivers: {
            ssh2: ssh.hasDriver(),
            mysql2: dbAdapters.driverStatus().mysql,
            oracledb: dbAdapters.driverStatus().oracle,
            pg: dbAdapters.driverStatus().postgres
        },
        hints: {
            ssh: ssh.MISSING_DEP,
            mysql: dbAdapters.DEP_HINT.mysql,
            oracle: dbAdapters.DEP_HINT.oracle,
            postgres: dbAdapters.DEP_HINT.postgres
        }
    }));

    ipcMain.handle('system:config:get', () => store.get('config'));

    ipcMain.handle('system:config:save', (e, patch = {}) => {
        const config = store.get('config');
        const before = config.modulePermEnabled;
        Object.assign(config, patch);
        store.persist();
        audit.write({ type: '操作', user: operator(), detail: '更新系统运行参数' });

        // 模块权限总开关发生变化 → 清理其它会话使新策略立即生效
        if ('modulePermEnabled' in patch && before !== config.modulePermEnabled) {
            auth.dropAllSessions(operator());
        }
        return { ok: true, config };
    });

    /* ---------------- 外置密钥配置（配置外挂） ---------------- */

    ipcMain.handle('system:secrets:status', () => secrets.status());

    ipcMain.handle('system:secrets:template', () => {
        const res = secrets.writeTemplate();
        audit.write({
            type: '操作', user: operator(), result: res.ok ? 'success' : 'failed',
            detail: `生成外置密钥文件模板：${res.file}${res.created ? '（新建）' : '（已存在未覆盖）'}`
        });
        return res;
    });

    /** 明文 → v1: 本机密文：让用户的外置文件不必明文存密钥 */
    ipcMain.handle('system:secrets:encrypt', (e, { plain } = {}) => secrets.encryptValue(plain));

    /* ---------------- 用户账号 ---------------- */

    ipcMain.handle('system:users:list', () => store.list('users').map(sanitizeUser));

    ipcMain.handle('system:users:save', (e, payload = {}) => {
        const name = String(payload.username || '').trim();
        const isNew = !payload.id;

        if (isNew && !name) return { ok: false, message: '请填写用户名' };
        if (isNew && store.list('users').some(u => u.username === name)) {
            return { ok: false, message: `用户名 ${name} 已存在` };
        }
        if (!Object.keys(auth.ROLE_CAPS).includes(payload.role)) {
            return { ok: false, message: '角色取值非法' };
        }

        const data = { ...payload };
        if (data.username) data.username = name;

        // 新增用户：生成初始口令（管理员转交给使用者，首次登录强制修改）
        if (isNew) {
            data.password = hashPassword(payload.password || 'Init@123456');
            data.mustChangePassword = true;
            data.enabled = payload.enabled !== false;
        } else if (payload.password) {
            data.password = hashPassword(payload.password);
            data.mustChangePassword = true;
        } else {
            delete data.password;
        }

        // 模块权限：显式传入矩阵则作为用户级覆写，传 null 表示恢复继承角色
        // 非管理员角色不允许在敏感模块上拿到 admin（防提权）
        if ('modulePerms' in payload) {
            data.modulePerms = payload.modulePerms
                ? perms.sanitizeMatrixForRole(payload.modulePerms, data.role || payload.role)
                : null;
        }

        const saved = store.upsert('users', data);
        // 角色/权限变更后，被改用户需要重新登录
        auth.dropAllSessions(operator());

        audit.write({
            type: '操作', user: operator(),
            detail: `${isNew ? '新增' : '修改'}用户 ${saved.username}（${saved.role}${saved.modulePerms ? ' · 自定义模块权限' : ' · 继承角色权限'}）`
        });
        return { ok: true, user: sanitizeUser(saved) };
    });

    ipcMain.handle('system:users:delete', (e, id) => {
        const u = store.find('users', id);
        if (!u) return { ok: false, message: '用户不存在' };
        if (u.username === operator()) return { ok: false, message: '不能删除当前登录用户' };
        if (u.username === 'admin') return { ok: false, message: '内置管理员账号不可删除' };

        const ok = store.remove('users', id);
        if (ok) {
            auth.dropAllSessions(operator());
            audit.write({ type: '操作', user: operator(), detail: `删除用户 ${u.username}` });
        }
        return { ok };
    });

    /* ---------------- 模块权限矩阵 ---------------- */

    ipcMain.handle('system:modules:list', () => ({
        modules: perms.MODULES,
        domains: perms.DOMAINS,
        levels: perms.LEVELS,
        levelLabels: perms.LEVEL_LABEL,
        roleDefaults: Object.keys(auth.ROLE_CAPS).reduce((acc, role) => {
            acc[role] = perms.roleDefaults(role);
            return acc;
        }, {})
    }));

    ipcMain.handle('system:perms:get', () => {
        const stored = store.get('modulePermissions') || {};
        const roles = {};
        Object.keys(auth.ROLE_CAPS).forEach(role => {
            roles[role] = role === '系统管理员'
                ? perms.roleDefaults(role)   // 管理员恒为全权限（只读展示）
                : perms.sanitizeMatrix(stored[role] || perms.roleDefaults(role));
        });

        const users = store.list('users').map(u => ({
            id: u.id,
            username: u.username,
            role: u.role,
            enabled: u.enabled !== false,
            override: !!(u.modulePerms && typeof u.modulePerms === 'object'),
            modules: auth.resolveMatrix(u)
        }));

        return {
            ok: true,
            modulePermEnabled: (store.get('config') || {}).modulePermEnabled !== false,
            roles,
            users
        };
    });

    ipcMain.handle('system:perms:save', (e, { role, matrix, modulePermEnabled } = {}) => {
        const config = store.get('config');
        if (typeof modulePermEnabled === 'boolean') config.modulePermEnabled = modulePermEnabled;

        if (role) {
            if (role === '系统管理员') {
                return { ok: false, message: '系统管理员默认拥有全部模块权限，无需配置' };
            }
            if (!Object.keys(auth.ROLE_CAPS).includes(role)) {
                return { ok: false, message: '角色取值非法' };
            }
            const db = store.load();
            if (!db.modulePermissions || typeof db.modulePermissions !== 'object') db.modulePermissions = {};
            db.modulePermissions[role] = perms.sanitizeMatrixForRole(matrix, role);
            store.persist();
            audit.write({
                type: '操作', user: operator(),
                detail: `更新角色「${role}」模块权限：授权 ${perms.countGrants(db.modulePermissions[role])} / ${perms.moduleIds().length} 个模块`
            });
        } else {
            store.persist();
            audit.write({ type: '操作', user: operator(), detail: `切换模块权限总开关为「${config.modulePermEnabled ? '启用' : '禁用'}」` });
        }

        // 权限变化后清理其它会话，让新策略下一次请求立即生效
        auth.dropAllSessions(operator());
        return { ok: true, role, matrix: role ? perms.sanitizeMatrixForRole(matrix, role) : undefined };
    });

    ipcMain.handle('system:perms:reset', (e, { role, scope } = {}) => {
        if (scope === 'users') {
            // 清空全部用户级覆写，统一回归角色权限
            store.list('users').forEach(u => { delete u.modulePerms; });
            store.persist();
            auth.dropAllSessions(operator());
            audit.write({ type: '操作', user: operator(), detail: '清空全部用户级模块权限覆写，回归角色权限' });
            return { ok: true };
        }

        const db = store.load();
        if (!db.modulePermissions) db.modulePermissions = {};
        const targets = role ? [role] : Object.keys(auth.ROLE_CAPS).filter(r => r !== '系统管理员');
        targets.forEach(r => { db.modulePermissions[r] = perms.roleDefaults(r); });
        store.persist();
        auth.dropAllSessions(operator());
        audit.write({ type: '操作', user: operator(), detail: `重置模块权限为系统默认（${targets.join('、')}）` });
        return { ok: true, roles: targets };
    });
}

module.exports = { setup };
