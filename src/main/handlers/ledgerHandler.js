/**
 * 凭据台账 IPC（系统运维域 · ledger 模块 · 仅系统管理员）
 * 通道：ledger:list / ledger:reveal
 *
 * 职责：把分散在三处集合中的账号口令（多系统账号 / 数据库数据源 / 主机 SSH）聚合为一份台账。
 * 安全模型：
 *   - 口令一律 AES-256-GCM 密文存储于本地库；列表接口只返回掩码，明文永不经列表下发
 *   - ledger:list / ledger:reveal 在 auth.js 中登记为 ADMIN_ONLY（角色能力层硬约束）
 *   - reveal 额外要求输入「当前登录账号的口令」二次校验（防挂机状态下直接查看），
 *     校验结果与每次查看均写入审计日志
 */
const store = require('../store');
const audit = require('../auditLogger');
const auth = require('../auth');
const { decrypt, mask, verifyPassword } = require('../crypto');

/** Vault 式解锁会话：口令校验一次后，有效期内查看其它条目免重复输入（参考 Vault token TTL） */
const UNLOCK_TTL_MS = 5 * 60 * 1000;
const unlockState = new Map();   // username → 过期时间戳
const isUnlocked = name => (unlockState.get(name) || 0) > Date.now();

/** kind → 集合与展示字段 */
const KINDS = {
    account: { coll: 'accounts', label: '业务系统', goto: 'accounts' },
    db: { coll: 'dbSources', label: '数据源', goto: 'dbconfig' },
    host: { coll: 'hosts', label: '主机 SSH', goto: 'hosts' },
    docker: { coll: 'dockerHosts', label: 'Docker 端点', goto: 'containers' }
};

const operator = () => (auth.getSession() || {}).username || '-';

/** 集合中的密文字段（accounts/dbSources/hosts 用 password，dockerHosts 用 token） */
const secretOf = item => item.password || item.token || '';

function targetOf(kind, item) {
    if (kind === 'account') return item.url || '-';
    if (kind === 'db') return [item.host, item.port, item.database].filter(Boolean).join(':') || '-';
    if (kind === 'docker') return (item.kind === 'tcp' ? `tcp://${item.host || '-'}:${item.port || 2375}` : '本机 socket');
    return `${item.ip || '-'}:${item.port || 22}`;
}

function rowOf(kind, item) {
    const has = !!secretOf(item);
    return {
        kind,
        kindLabel: KINDS[kind].label,
        goto: KINDS[kind].goto,
        id: item.id,
        name: item.name || '-',
        target: targetOf(kind, item),
        user: item.user || (kind === 'docker' ? (item.token ? 'Bearer Token' : '-') : '-'),
        hasPassword: has,
        passwordMasked: has ? mask() : '',
        note: kind === 'account' ? (item.scriptName || '')
            : kind === 'db' ? [item.type, item.enabled === false ? '已停用' : ''].filter(Boolean).join(' · ')
                : kind === 'docker' ? ((item.tags || []).join('、') || item.note || '')
                    : ((item.tags || []).join('、') || (item.authType === 'key' ? '密钥认证' : '')),
        status: kind === 'account' ? item.status : (item.enabled === false ? 'disabled' : 'ok'),
        expiresAt: kind === 'account' ? (item.expiresAt || '') : '',
        updatedAt: item.lastSyncAt || item.lastTestAt || item.lastConnectedAt || ''
    };
}

function setup(ipcMain) {
    /** 台账列表：全部集合聚合，口令仅掩码 */
    ipcMain.handle('ledger:list', () => {
        const rows = [];
        store.list('accounts').forEach(x => rows.push(rowOf('account', x)));
        store.list('dbSources').forEach(x => rows.push(rowOf('db', x)));
        store.list('hosts')
            .filter(x => x.authType === 'password')
            .forEach(x => rows.push(rowOf('host', x)));
        store.list('dockerHosts')
            .filter(x => !!x.token)
            .forEach(x => rows.push(rowOf('docker', x)));
        return rows;
    });

    /* ---------------- 解锁会话（Vault unseal 式） ---------------- */

    ipcMain.handle('ledger:status', () => {
        const username = operator();
        const until = unlockState.get(username) || 0;
        return { ok: true, unlocked: isUnlocked(username), until };
    });

    ipcMain.handle('ledger:unlock', (e, payload = {}) => {
        const username = operator();
        const user = store.list('users').find(u => u.username === username);
        if (!user || !verifyPassword(payload.password, user.password)) {
            audit.write({ type: '操作', user: username, result: 'failed', detail: '台账解锁失败（登录口令不正确）' });
            return { ok: false, message: '登录口令校验失败' };
        }
        const until = Date.now() + UNLOCK_TTL_MS;
        unlockState.set(username, until);
        audit.write({ type: '操作', user: username, detail: `台账解锁（有效期 ${UNLOCK_TTL_MS / 60000} 分钟）` });
        return { ok: true, until, ttlMs: UNLOCK_TTL_MS };
    });

    ipcMain.handle('ledger:lock', () => {
        const username = operator();
        unlockState.delete(username);
        audit.write({ type: '操作', user: username, detail: '台账上锁' });
        return { ok: true };
    });

    /**
     * 解密查看单条凭据
     * payload: { kind, id, password } —— 未解锁时必须提供当前登录口令；解锁有效期内可免口令
     */
    ipcMain.handle('ledger:reveal', (e, payload = {}) => {
        const { kind, id, password } = payload;
        const def = KINDS[kind];
        if (!def) return { ok: false, message: '凭据类型非法' };

        const username = operator();
        if (!isUnlocked(username)) {
            if (!password) return { ok: false, message: '台账已锁定，请输入当前账号的登录口令', locked: true };
            const user = store.list('users').find(u => u.username === username);
            if (!user || !verifyPassword(password, user.password)) {
                audit.write({
                    type: '操作', user: username, result: 'failed',
                    detail: `台账解密校验失败（口令不正确）：目标 ${def.label} #${id}`
                });
                return { ok: false, message: '登录口令校验失败，操作已记入审计' };
            }
            // 口令校验通过 → 顺带开启解锁会话（Vault 续期语义），后续条目免重复输入
            unlockState.set(username, Date.now() + UNLOCK_TTL_MS);
        }

        const item = store.find(def.coll, id);
        if (!item) return { ok: false, message: '凭据不存在（可能已被删除）' };
        const plain = decrypt(secretOf(item));
        if (!plain) return { ok: false, message: '该条目没有已保存的口令，或密文无法解密（本机密钥与数据不匹配）' };

        audit.write({
            type: '操作', user: username,
            detail: `查看台账明文凭据：${def.label}「${item.name}」账号 ${item.user || '-'}`
        });
        return { ok: true, password: plain, name: item.name, user: item.user || '-' };
    });
}

module.exports = { setup };
