/**
 * 本地存储层 · JSON 文件库
 * 位置：<userData>/data/sgops.json（首次运行写入种子数据）
 * 说明：内网单机部署场景，采用原子写（临时文件 + rename）避免写坏文件
 */
const fs = require('fs');
const path = require('path');
const { app } = require('electron');
const { encrypt, hashPassword } = require('./crypto');
const permissionsMod = require('./permissions');

const DATA_DIR = path.join(app.getPath('userData'), 'data');
const LOG_DIR = path.join(app.getPath('userData'), 'logs');
const DB_FILE = path.join(DATA_DIR, 'sgops.json');

function uid(prefix) {
    return prefix + '_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
}

function nowText() {
    const d = new Date();
    const p = n => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

function seeds() {
    const secret = encrypt('Init@12345');
    return {
        config: {
            maxConcurrency: 10,
            cmdTimeout: 30,
            highRiskAction: 'block',
            whitelistEnabled: true,
            logRetentionDays: 180,
            alertMode: 'ui',
            currentUser: 'admin',
            // 模块权限总开关：关闭后所有角色按系统内置默认权限执行
            modulePermEnabled: true
        },
        // AI 模型配置（apiKey 为密文，出参一律掩码）
        aiConfig: {
            provider: 'deepseek',
            baseURL: 'https://api.deepseek.com',
            apiKey: '',
            model: 'deepseek-chat'
        },
        // AI 对话历史：{ username: [{ role, content, at }] }
        aiChats: {},
        // Agent 全局能力配置（能力默认收紧，由管理员在「AI 配置」页放开）
        aiAgent: {
            enabled: false,
            maxSteps: 6,
            allowDataGenerate: true,
            allowSaveScript: true,
            allowLocalExec: false,
            allowSqlExecute: false,
            commandTimeout: 15,
            maxRows: 200
        },
        // AI 用户级偏好：{ username: { model, agentEnabled } }
        aiUserPrefs: {},
        // 数据集成（ETL）：可复用的同步任务 + 最近执行记录
        etlTasks: [],
        etlRuns: [],
        // 模块 → 角色 的界面/功能权限矩阵（未出现的角色使用内置默认值）
        modulePermissions: {
            '运维员': permissionsMod.roleDefaults('运维员'),
            '审计员': permissionsMod.roleDefaults('审计员')
        },        counter: { task: 31 },
        hosts: [
            { id: 'h_01', name: 'app-server-01', ip: '10.0.12.11', port: 22, user: 'root', authType: 'key', keyPath: '', password: '', tags: ['生产', '应用'], status: 'unknown', lastConnectedAt: '2026-09-16 14:02' },
            { id: 'h_02', name: 'app-server-02', ip: '10.0.12.12', port: 22, user: 'root', authType: 'key', keyPath: '', password: '', tags: ['生产', '应用'], status: 'unknown', lastConnectedAt: '2026-09-16 14:02' },
            { id: 'h_03', name: 'web-server-01', ip: '10.0.12.21', port: 22, user: 'deploy', authType: 'key', keyPath: '', password: '', tags: ['生产', 'Web'], status: 'unknown', lastConnectedAt: '2026-09-16 13:40' },
            { id: 'h_04', name: 'db-server-01', ip: '10.0.20.31', port: 22, user: 'oracle', authType: 'password', keyPath: '', password: secret, tags: ['生产', '数据库'], status: 'unknown', lastConnectedAt: '2026-09-16 11:40' },
            { id: 'h_05', name: 'db-server-02', ip: '10.0.20.32', port: 22, user: 'oracle', authType: 'password', keyPath: '', password: secret, tags: ['生产', '数据库'], status: 'offline', lastConnectedAt: '2026-09-15 22:10' },
            { id: 'h_06', name: 'bigdata-node-01', ip: '10.0.30.41', port: 22, user: 'root', authType: 'key', keyPath: '', password: '', tags: ['大数据'], status: 'unknown', lastConnectedAt: '2026-09-16 10:15' },
            { id: 'h_07', name: 'bigdata-node-02', ip: '10.0.30.42', port: 22, user: 'root', authType: 'key', keyPath: '', password: '', tags: ['大数据'], status: 'unknown', lastConnectedAt: '2026-09-16 10:15' },
            { id: 'h_08', name: 'test-server-01', ip: '192.168.5.11', port: 22, user: 'root', authType: 'password', keyPath: '', password: secret, tags: ['测试'], status: 'unknown', lastConnectedAt: '2026-09-16 09:31' },
            { id: 'h_09', name: 'backup-server-01', ip: '10.0.40.51', port: 2222, user: 'backup', authType: 'key', keyPath: '', password: '', tags: ['备份'], status: 'unknown', lastConnectedAt: '2026-09-16 03:00' }
        ],
        scripts: [
            { id: 's_01', name: 'check_disk.sh', type: 'shell', desc: '磁盘使用率巡检，超 85% 告警', version: 'v3', author: 'admin', content: '#!/bin/bash\n# 磁盘使用率巡检\nTHRESHOLD=85\nUSED=$(df -h / | awk \'NR==2 {print $5}\' | tr -d \'%\')\nif [ "$USED" -ge "$THRESHOLD" ]; then\n  echo "[WARN] 根分区使用率 ${USED}%"\n  exit 1\nfi\necho "[OK] 根分区使用率 ${USED}%"', createdAt: '2026-09-12 10:20', updatedAt: '2026-09-12 10:20' },
            { id: 's_02', name: 'clean_logs.sh', type: 'shell', desc: '清理 7 天前的历史日志', version: 'v5', author: 'admin', content: '#!/bin/bash\n# 清理历史日志\nfind /var/log -type f -mtime +7 -name "*.log" -delete\necho "日志清理完成"', createdAt: '2026-09-10 15:02', updatedAt: '2026-09-10 15:02' },
            { id: 's_03', name: 'sync_config.sh', type: 'shell', desc: '从配置中心拉取并分发配置', version: 'v2', author: 'ops01', content: '#!/bin/bash\n# 同步配置\ncurl -s -o /tmp/app.conf http://config.corp.local/app.conf\ncp /tmp/app.conf /etc/app/app.conf\necho "配置已同步"', createdAt: '2026-09-08 09:41', updatedAt: '2026-09-08 09:41' },
            { id: 's_04', name: 'update_cert.py', type: 'python', desc: '批量续期 HTTPS 证书并 reload nginx', version: 'v1.3', author: 'admin', content: 'import subprocess\n\ndef main():\n    subprocess.run(["certbot", "renew", "--quiet"], check=True)\n    subprocess.run(["systemctl", "reload", "nginx"], check=True)\n    print("证书续期完成")\n\nif __name__ == "__main__":\n    main()', createdAt: '2026-09-14 08:30', updatedAt: '2026-09-16 09:47' },
            { id: 's_05', name: 'reset_password.py', type: 'python', desc: '第三方系统模拟登录重置密码', version: 'v2.1', author: 'admin', content: '# 第三方系统模拟登录并重置密码\n# 入参：系统地址 / 账号 / 新密码（由平台注入）\nimport os, requests\n\ndef main():\n    url = os.environ["SYS_URL"]\n    user = os.environ["SYS_USER"]\n    newpwd = os.environ["NEW_PASSWORD"]\n    s = requests.Session()\n    s.post(f"{url}/login", data={"username": user, "password": newpwd})\n    print("密码重置完成：", user)\n\nif __name__ == "__main__":\n    main()', createdAt: '2026-09-14 11:05', updatedAt: '2026-09-14 11:05' },
            { id: 's_06', name: 'db_backup.sh', type: 'shell', desc: 'Oracle 数据库逻辑备份导出', version: 'v4', author: 'ops01', content: '#!/bin/bash\n# Oracle 逻辑备份\nexpdp system/password@orcl directory=DPUMP dumpfile=full_$(date +%F).dmp full=y\necho "备份完成"', createdAt: '2026-09-05 16:20', updatedAt: '2026-09-05 16:20' }
        ],
        rules: [
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
        ],
        accounts: [
            { id: 'a_01', name: '堡垒机系统', url: 'https://bastion.corp.local', user: 'svc_ops', password: secret, scriptName: 'login_bastion.py', status: 'ok', lastSyncAt: '2026-09-16 08:00' },
            { id: 'a_02', name: 'OA 办公系统', url: 'https://oa.corp.local', user: 'svc_admin', password: secret, scriptName: 'login_oa.py', status: 'ok', lastSyncAt: '2026-09-15 18:30' },
            { id: 'a_03', name: '邮件系统', url: 'https://mail.corp.local', user: 'svc_mail', password: secret, scriptName: 'login_mail.py', status: 'expired', lastSyncAt: '2026-09-14 10:00' },
            { id: 'a_04', name: '财务共享平台', url: 'https://fin.corp.local', user: 'svc_fin', password: secret, scriptName: 'login_fin.py', status: 'ok', lastSyncAt: '2026-09-16 06:00' },
            { id: 'a_05', name: '监控平台', url: 'https://zabbix.corp.local', user: 'svc_monitor', password: secret, scriptName: 'login_zabbix.py', status: 'error', lastSyncAt: '2026-09-10 09:00' }
        ],
        tasks: [
            { id: 'T-20260916-0031', cmd: 'df -h', hostIds: ['h_01', 'h_02'], hostCount: 12, status: 'running', operator: 'admin', createdAt: '2026-09-16 14:02:11', results: [] },
            { id: 'T-20260916-0030', cmd: 'find /var/log -mtime +7 -delete', hostIds: ['h_03'], hostCount: 8, status: 'success', operator: 'admin', createdAt: '2026-09-16 11:40:02', results: [] },
            { id: 'T-20260916-0029', cmd: 'systemctl restart nginx', hostIds: ['h_03'], hostCount: 3, status: 'success', operator: 'ops01', createdAt: '2026-09-16 10:15:33', results: [] },
            { id: 'T-20260916-0028', cmd: 'rm -rf /var/log', hostIds: ['h_01'], hostCount: 16, status: 'blocked', operator: 'ops01', createdAt: '2026-09-16 09:31:20', results: [] },
            { id: 'T-20260915-0047', cmd: 'sysctl -p', hostIds: ['h_06'], hostCount: 26, status: 'failed', operator: 'admin', createdAt: '2026-09-15 17:22:45', results: [] }
        ],
        users: [
            { id: 'u_01', username: 'admin', role: '系统管理员', enabled: true, lastLoginAt: '2026-09-16 09:12', password: hashPassword('admin@123'), mustChangePassword: true },
            { id: 'u_02', username: 'ops01', role: '运维员', enabled: true, lastLoginAt: '2026-09-16 13:05', password: hashPassword('ops@123'), mustChangePassword: true },
            { id: 'u_03', username: 'auditor01', role: '审计员', enabled: true, lastLoginAt: '2026-09-15 16:40', password: hashPassword('audit@123'), mustChangePassword: true },
            { id: 'u_04', username: 'ops02', role: '运维员', enabled: false, lastLoginAt: '2026-08-30 10:12', password: hashPassword('ops@123'), mustChangePassword: true }
        ],
        dbSources: [
            { id: 'd_01', type: 'oracle', name: 'Oracle（生产库）', host: '10.0.20.31', port: 1521, database: 'orcl', user: 'system', password: secret, status: 'configured', note: '连接池 8', enabled: true, tags: ['生产', 'Oracle'], lastTestAt: '2026-09-16 11:00:12', lastTestOk: true, createdAt: '2026-09-10 09:20' },
            { id: 'd_02', type: 'mysql', name: 'MySQL（业务库）', host: '', port: 3306, database: '', user: '', password: '', status: 'unconfigured', note: '', enabled: true, tags: ['业务', 'MySQL'], lastTestAt: null, lastTestOk: null, createdAt: '2026-09-10 09:22' },
            { id: 'd_03', type: 'postgres', name: 'PostgreSQL', host: '', port: 5432, database: '', user: '', password: '', status: 'pending', note: '驱动接口已预留，待后续版本接入', enabled: false, tags: ['预留'], lastTestAt: null, lastTestOk: null, createdAt: '2026-09-10 09:25' }
        ],
        schedules: [
            {
                id: 'sc_01', name: '每日磁盘巡检', mode: 'daily', time: '08:30',
                cmd: 'df -h', scriptId: null, hostIds: ['h_01', 'h_02', 'h_03'],
                concurrency: 5, timeout: 30, enabled: true,
                nextRunAt: null, lastRunAt: '2026-09-16 08:30:01', lastStatus: 'success', lastTaskId: null
            },
            {
                id: 'sc_02', name: '每 30 分钟日志清理', mode: 'interval', intervalMinutes: 30,
                cmd: '', scriptId: 's_02', hostIds: ['h_01', 'h_02'],
                concurrency: 3, timeout: 60, enabled: false,
                nextRunAt: null, lastRunAt: null, lastStatus: null, lastTaskId: null
            }
        ],
        sqlScripts: [
            {
                id: 'sq_01', name: '慢查询 Top 10', sourceType: 'mysql',
                sql: 'SELECT * FROM information_schema.processlist\nWHERE command <> \'Sleep\'\nORDER BY time DESC\nLIMIT 10;',
                author: 'admin', createdAt: '2026-09-16 10:00', updatedAt: '2026-09-16 10:00'
            },
            {
                id: 'sq_02', name: '表容量概览', sourceType: 'mysql',
                sql: 'SELECT table_name, table_rows,\n       ROUND(data_length / 1024 / 1024, 2) AS data_mb,\n       ROUND(index_length / 1024 / 1024, 2) AS index_mb\nFROM information_schema.tables\nWHERE table_schema = DATABASE()\nORDER BY data_length DESC\nLIMIT 50;',
                author: 'admin', createdAt: '2026-09-16 10:05', updatedAt: '2026-09-16 10:05'
            }
        ],
        alerts: [],
        sqlHistory: [
            {
                id: 'q_seed01', sourceId: 'd_01', sourceName: 'Oracle（生产库）', type: 'oracle', user: 'admin',
                sql: "SELECT s.sid, s.username FROM v$session s WHERE s.status = 'ACTIVE'",
                result: 'success', statementCount: 1, durationMs: 88, rowCount: 12,
                createdAt: '2026-09-16 11:02:45'
            },
            {
                id: 'q_seed02', sourceId: 'd_02', sourceName: 'MySQL（业务库）', type: 'mysql', user: 'ops01',
                sql: 'DROP DATABASE bizdb',
                result: 'blocked', statementCount: 1, durationMs: 0, rowCount: 0,
                message: '已拦截：不允许执行 DROP DATABASE / DROP SCHEMA',
                createdAt: '2026-09-16 09:20:03'
            }
        ]
    };
}

let db = null;

function ensureDirs() {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.mkdirSync(LOG_DIR, { recursive: true });
}

function load() {
    if (db) return db;
    ensureDirs();
    if (fs.existsSync(DB_FILE)) {
        try {
            db = JSON.parse(fs.readFileSync(DB_FILE, 'utf8'));
        } catch (e) {
            // 文件损坏时备份并重建种子数据
            fs.copyFileSync(DB_FILE, DB_FILE + '.broken-' + Date.now());
            db = seeds();
            persist();
        }
    } else {
        db = seeds();
        persist();
    }
    migrate();
    return db;
}

/**
 * 老版本数据文件迁移：补齐新增集合与字段，避免升级后功能缺字段
 */
function migrate() {
    const defaults = seeds();
    let changed = false;

    ['hosts', 'scripts', 'rules', 'accounts', 'tasks', 'users', 'dbSources', 'schedules', 'sqlScripts', 'sqlHistory', 'alerts',
        'etlTasks', 'etlRuns'].forEach(key => {
        if (!Array.isArray(db[key])) {
            db[key] = defaults[key] || [];
            changed = true;
        }
    });

    if (!db.config) { db.config = defaults.config; changed = true; }
    if (!db.counter) { db.counter = defaults.counter; changed = true; }

    // AI 模型配置 / 对话历史（老库没有 → 补默认）
    if (!db.aiConfig || typeof db.aiConfig !== 'object') { db.aiConfig = defaults.aiConfig; changed = true; }
    if (!db.aiChats || typeof db.aiChats !== 'object' || Array.isArray(db.aiChats)) { db.aiChats = {}; changed = true; }
    // Agent 配置 / 用户级 AI 偏好（老库补默认值，缺失字段由 ai.getAgentConfig 兜底）
    if (!db.aiAgent || typeof db.aiAgent !== 'object' || Array.isArray(db.aiAgent)) { db.aiAgent = defaults.aiAgent; changed = true; }
    if (!db.aiUserPrefs || typeof db.aiUserPrefs !== 'object' || Array.isArray(db.aiUserPrefs)) { db.aiUserPrefs = {}; changed = true; }

    // 模块权限矩阵（老库没有该集合 → 按角色内置默认值补全）
    if (!db.modulePermissions || typeof db.modulePermissions !== 'object' || Array.isArray(db.modulePermissions)) {
        db.modulePermissions = {};
        changed = true;
    }
    Object.keys(permissionsMod.ROLE_MODULE_DEFAULTS).forEach(role => {
        if (role === '系统管理员') return; // 管理员始终全权限，不落库
        if (!db.modulePermissions[role]) {
            db.modulePermissions[role] = permissionsMod.roleDefaults(role);
            changed = true;
        } else {
            // 新增模块：老矩阵里没有该键时按角色内置默认值回填（显式 null 视为「已决策」不动）
            const matrix = db.modulePermissions[role];
            permissionsMod.MODULES.forEach(m => {
                if (!(m.id in matrix)) {
                    matrix[m.id] = permissionsMod.roleDefaults(role)[m.id] || null;
                    changed = true;
                }
            });
            const normalized = permissionsMod.sanitizeMatrixForRole(matrix, role);
            if (JSON.stringify(normalized) !== JSON.stringify(matrix)) {
                db.modulePermissions[role] = normalized;
                changed = true;
            }
        }
    });
    // 用户级模块权限覆写（存在则规范化，缺失时保持 null 表示继承角色）
    (db.users || []).forEach(user => {
        if (user.modulePerms && typeof user.modulePerms === 'object') {
            const normalized = permissionsMod.sanitizeMatrixForRole(user.modulePerms, user.role);
            if (JSON.stringify(normalized) !== JSON.stringify(user.modulePerms)) {
                user.modulePerms = normalized;
                changed = true;
            }
        }
    });

    // 数据源新增字段（启用开关 / 标签 / 最近测试）
    (db.dbSources || []).forEach(src => {
        if (typeof src.enabled !== 'boolean') { src.enabled = src.type !== 'postgres'; changed = true; }
        if (!Array.isArray(src.tags)) { src.tags = []; changed = true; }
        if (!('note' in src)) { src.note = ''; changed = true; }
        if (!('lastTestAt' in src)) { src.lastTestAt = null; changed = true; }
        if (!('lastTestOk' in src)) { src.lastTestOk = null; changed = true; }
    });

    // 用户表新增口令字段（老库没有密码 → 补默认口令并要求修改）
    (db.users || []).forEach((user, index) => {
        if (!user.password) {
            const fallback = defaults.users.find(u => u.username === user.username) || defaults.users[index] || defaults.users[0];
            user.password = fallback.password;
            user.mustChangePassword = true;
            changed = true;
        }
    });

    if (changed) persist();
}

function persist() {
    ensureDirs();
    const tmp = DB_FILE + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(db, null, 2), 'utf8');
    fs.renameSync(tmp, DB_FILE);
}

const list = coll => load()[coll] || [];
const get = key => load()[key];
const find = (coll, id) => list(coll).find(x => x.id === id) || null;

function set(key, value) {
    load()[key] = value;
    persist();
    return value;
}

function upsert(coll, item) {
    const arr = list(coll);
    const prefix = {
        hosts: 'h_', scripts: 's_', rules: 'r_', accounts: 'a_', users: 'u_',
        dbSources: 'd_', tasks: 'T-', etlTasks: 'et_', etlRuns: 'er_', sqlScripts: 'sq_'
    }[coll] || 'x_';
    if (item.id) {
        const idx = arr.findIndex(x => x.id === item.id);
        if (idx >= 0) {
            arr[idx] = { ...arr[idx], ...item };
            persist();
            return arr[idx];
        }
    }
    const created = { ...item, id: item.id || uid(prefix) };
    arr.unshift(created);
    persist();
    return created;
}

function remove(coll, id) {
    const arr = list(coll);
    const idx = arr.findIndex(x => x.id === id);
    if (idx < 0) return false;
    arr.splice(idx, 1);
    persist();
    return true;
}

/** 任务编号：T-YYYYMMDD-XXXX */
function nextTaskId() {
    const d = new Date();
    const p = n => String(n).padStart(2, '0');
    const day = `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}`;
    const state = load();
    state.counter.task = (state.counter.task || 0) + 1;
    persist();
    return `T-${day}-${String(state.counter.task).padStart(4, '0')}`;
}

module.exports = {
    load, persist, list, get, set, find, upsert, remove,
    nextTaskId, uid, nowText, ensureDirs,
    DATA_DIR, LOG_DIR, DB_FILE
};
