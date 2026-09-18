/**
 * 数据库配置 IPC（数据库运维 · 独立模块）
 * 通道：
 *   dbconfig:list     数据源列表（脱敏）
 *   dbconfig:detail   单个数据源详情（脱敏）
 *   dbconfig:save     新增 / 修改（密码密文存储，留空表示不改）
 *   dbconfig:delete   删除
 *   dbconfig:toggle   启用 / 停用
 *   dbconfig:test     连接测试（写回状态与最近测试时间）
 *   dbconfig:export   导出配置（不含密码，便于跨机迁移）
 *   dbconfig:import   导入配置（合并同 id / 同 name）
 *   dbconfig:drivers  驱动可用性与安装提示
 *
 * 说明：SQL 执行与库表浏览属于 SQL 工作台（dbHandler.js），此处只负责「数据源」本身。
 */
const store = require('../store');
const audit = require('../auditLogger');
const dbAdapters = require('../dbAdapters');
const { encrypt, mask } = require('../crypto');

const TYPES = [
    { id: 'mysql', label: 'MySQL', port: 3306, driver: 'mysql2', available: true },
    { id: 'oracle', label: 'Oracle', port: 1521, driver: 'oracledb', available: true },
    { id: 'postgres', label: 'PostgreSQL', port: 5432, driver: 'pg', available: false, note: '驱动接口已预留，待后续版本接入' }
];

const SCHEMA_VERSION = 1;

/** 出参脱敏：绝不返回明文密码 */
function sanitize(source) {
    const { password, ...rest } = source;
    return {
        ...rest,
        hasPassword: !!password,
        passwordMasked: password ? mask() : '',
        usable: !!(source.host && source.user && source.database !== undefined)
    };
}

const operator = () => (require('../auth').getSession() || {}).username || (store.get('config') || {}).currentUser || '-';

function log(detail, result = 'success') {
    audit.write({ type: '操作', user: operator(), detail, result });
}

/** 归一化入参，防止把任意字段写进库 */
function normalize(payload = {}) {
    const type = TYPES.some(t => t.id === payload.type) ? payload.type : 'mysql';
    const port = parseInt(payload.port, 10);
    const meta = TYPES.find(t => t.id === type);
    return {
        id: payload.id || undefined,
        type,
        name: String(payload.name || '').trim() || `${meta.label} 数据源`,
        host: String(payload.host || '').trim(),
        port: Number.isFinite(port) && port > 0 ? port : meta.port,
        database: String(payload.database || '').trim(),
        user: String(payload.user || '').trim(),
        note: String(payload.note || '').trim().slice(0, 200),
        tags: Array.isArray(payload.tags)
            ? payload.tags.map(t => String(t).trim()).filter(Boolean).slice(0, 8)
            : String(payload.tags || '').split(/[,，\s]+/).map(t => t.trim()).filter(Boolean).slice(0, 8)
    };
}

/** 根据配置完整度推断状态 */
const deriveStatus = (data, prev) =>
    data.host && data.user
        ? (prev && prev.status === 'error' ? 'error' : 'configured')
        : (data.type === 'postgres' && !data.host ? 'pending' : 'unconfigured');

function setup(ipcMain) {
    /* ---------------- 列表 / 详情 ---------------- */

    ipcMain.handle('dbconfig:list', () => {
        const drivers = dbAdapters.driverStatus();
        return store.list('dbSources').map(s => ({
            ...sanitize(s),
            driverReady: !!drivers[s.type]
        }));
    });

    ipcMain.handle('dbconfig:detail', (e, id) => {
        const src = store.find('dbSources', id);
        if (!src) return { ok: false, message: '数据源不存在' };
        return { ok: true, source: sanitize(src) };
    });

    ipcMain.handle('dbconfig:drivers', () => ({
        drivers: dbAdapters.driverStatus(),
        hints: dbAdapters.DEP_HINT,
        types: TYPES
    }));

    /* ---------------- 保存 ---------------- */

    ipcMain.handle('dbconfig:save', (e, payload = {}) => {
        const data = normalize(payload);
        if (payload.id && !store.find('dbSources', payload.id)) {
            return { ok: false, message: '数据源不存在，可能已被删除' };
        }
        if (data.host && !/^[\w.\-:]+$/.test(data.host)) {
            return { ok: false, message: '主机地址含非法字符' };
        }

        // 密码处理：留空 / 掩码占位 → 不修改既有密文
        const prev = payload.id ? store.find('dbSources', payload.id) : null;
        const incoming = payload.password;
        if (incoming && incoming !== mask()) {
            data.password = encrypt(incoming);
        } else if (prev) {
            data.password = prev.password;   // 保持原密文
            data.hasPassword = true;
        } else {
            data.password = '';
        }

        data.status = deriveStatus(data, prev);
        data.enabled = typeof payload.enabled === 'boolean' ? payload.enabled : (prev ? prev.enabled !== false : true);
        data.lastTestAt = prev ? prev.lastTestAt || null : null;
        data.lastTestOk = prev ? prev.lastTestOk ?? null : null;
        data.createdAt = prev ? prev.createdAt || store.nowText() : store.nowText();
        data.updatedAt = store.nowText();

        const saved = store.upsert('dbSources', data);
        log(`${prev ? '修改' : '新增'}数据源「${saved.name}」（${saved.type} ${saved.host || '-'}:${saved.port}）`);
        return { ok: true, source: sanitize(saved) };
    });

    ipcMain.handle('dbconfig:delete', (e, id) => {
        const src = store.find('dbSources', id);
        if (!src) return { ok: false, message: '数据源不存在' };
        const ok = store.remove('dbSources', id);
        if (ok) log(`删除数据源「${src.name}」（${src.type}）`);
        return { ok };
    });

    ipcMain.handle('dbconfig:toggle', (e, { id, enabled }) => {
        const src = store.find('dbSources', id);
        if (!src) return { ok: false, message: '数据源不存在' };
        src.enabled = !!enabled;
        src.updatedAt = store.nowText();
        store.persist();
        log(`${src.enabled ? '启用' : '停用'}数据源「${src.name}」`);
        return { ok: true, source: sanitize(src) };
    });

    /* ---------------- 连接测试 ---------------- */

    ipcMain.handle('dbconfig:test', async (e, id) => {
        const src = store.find('dbSources', id);
        if (!src) return { ok: false, message: '数据源不存在' };
        if (!src.host || !src.user) return { ok: false, message: '请先填写主机地址与用户名' };

        const result = await dbAdapters.testConnection(src);
        src.lastTestAt = store.nowText();
        src.lastTestOk = !!result.ok;
        src.status = result.ok ? 'connected' : 'error';
        store.persist();

        log(`数据源「${src.name}」连接测试：${result.message}`, result.ok ? 'success' : 'failed');
        return { ...result, source: sanitize(src) };
    });

    /* ---------------- 导入 / 导出 ---------------- */

    ipcMain.handle('dbconfig:export', () => {
        const list = store.list('dbSources').map(s => {
            const { password, ...rest } = s;
            return { ...rest, password: '' };   // 导出永不含密文
        });
        log(`导出数据源配置（${list.length} 条，不含口令）`);
        return {
            ok: true,
            schemaVersion: SCHEMA_VERSION,
            exportedAt: store.nowText(),
            count: list.length,
            sources: list
        };
    });

    ipcMain.handle('dbconfig:import', (e, { sources, overwrite = false } = {}) => {
        if (!Array.isArray(sources) || !sources.length) {
            return { ok: false, message: '导入内容为空或格式不正确' };
        }
        let created = 0, updated = 0, skipped = 0;

        sources.forEach(raw => {
            const data = normalize(raw);
            // 导入条目必须是「全新」或命中已有条目（按 id / 名称）
            const existing = (raw.id && store.find('dbSources', raw.id))
                || store.list('dbSources').find(s => s.name === data.name);
            if (existing && !overwrite) { skipped++; return; }

            if (existing) {
                Object.assign(existing, {
                    name: data.name, type: data.type, host: data.host, port: data.port,
                    database: data.database, user: data.user, note: data.note, tags: data.tags,
                    status: existing.host ? existing.status : deriveStatus(data, existing),
                    updatedAt: store.nowText()
                });
                updated++;
            } else {
                store.upsert('dbSources', { ...data, status: deriveStatus(data, null), enabled: true, createdAt: store.nowText() });
                created++;
            }
        });
        store.persist();
        log(`导入数据源配置：新增 ${created} / 更新 ${updated} / 跳过 ${skipped}`);
        return { ok: true, created, updated, skipped };
    });
}

module.exports = { setup, TYPES };
