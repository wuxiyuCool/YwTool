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

/** kind → 集合与展示字段 */
const KINDS = {
    account: { coll: 'accounts', label: '业务系统', goto: 'accounts' },
    db: { coll: 'dbSources', label: '数据源', goto: 'dbconfig' },
    host: { coll: 'hosts', label: '主机 SSH', goto: 'hosts' }
};

const operator = () => (auth.getSession() || {}).username || '-';

function targetOf(kind, item) {
    if (kind === 'account') return item.url || '-';
    if (kind === 'db') return [item.host, item.port, item.database].filter(Boolean).join(':') || '-';
    return `${item.ip || '-'}:${item.port || 22}`;
}

function rowOf(kind, item) {
    const has = !!item.password;
    return {
        kind,
        kindLabel: KINDS[kind].label,
        goto: KINDS[kind].goto,
        id: item.id,
        name: item.name || '-',
        target: targetOf(kind, item),
        user: item.user || '-',
        hasPassword: has,
        passwordMasked: has ? mask() : '',
        note: kind === 'account' ? (item.scriptName || '')
            : kind === 'db' ? [item.type, item.enabled === false ? '已停用' : ''].filter(Boolean).join(' · ')
                : ((item.tags || []).join('、') || (item.authType === 'key' ? '密钥认证' : '')),
        status: kind === 'account' ? item.status : kind === 'db' ? (item.enabled === false ? 'disabled' : 'ok') : (item.status || 'unknown'),
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
        return rows;
    });

    /**
     * 解密查看单条凭据
     * payload: { kind, id, password }  —— password 为当前登录账号的登录口令（二次校验）
     */
    ipcMain.handle('ledger:reveal', (e, payload = {}) => {
        const { kind, id, password } = payload;
        const def = KINDS[kind];
        if (!def) return { ok: false, message: '凭据类型非法' };
        if (!password) return { ok: false, message: '请输入当前账号的登录口令' };

        const username = operator();
        const user = store.list('users').find(u => u.username === username);
        if (!user || !verifyPassword(password, user.password)) {
            audit.write({
                type: '操作', user: username, result: 'failed',
                detail: `台账解密校验失败（口令不正确）：目标 ${def.label} #${id}`
            });
            return { ok: false, message: '登录口令校验失败，操作已记入审计' };
        }

        const item = store.find(def.coll, id);
        if (!item) return { ok: false, message: '凭据不存在（可能已被删除）' };
        const plain = decrypt(item.password);
        if (!plain) return { ok: false, message: '该条目没有已保存的口令，或密文无法解密（本机密钥与数据不匹配）' };

        audit.write({
            type: '操作', user: username,
            detail: `查看台账明文凭据：${def.label}「${item.name}」账号 ${item.user || '-'}`
        });
        return { ok: true, password: plain, name: item.name, user: item.user || '-' };
    });
}

module.exports = { setup };
