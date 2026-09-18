/**
 * SQL 工作台 IPC
 * 通道：sql:execute / sql:export / db:tables / db:describe / db:schema
 *       sqlScripts:list|save|delete / sqlHistory:list
 *       db:etl:preview|run|pickFile / db:etl:tasks:list|save|delete / db:etl:runs（数据集成 ETL）
 *
 * 安全约束：
 *   - sql:execute 为管理员专属通道（见 auth.ADMIN_ONLY）
 *   - 单次最多 10 条语句（分号拆分，逐条执行并逐条返回结果）
 *   - DROP DATABASE / DROP SCHEMA 一律拒绝
 *   - 全部执行（无论成败）写入审计日志 + 执行历史
 */
const store = require('../store');
const audit = require('../auditLogger');
const auth = require('../auth');
const dbAdapters = require('../dbAdapters');
const etl = require('../etl');

const MAX_STATEMENTS = 10;
const MAX_ROWS = 500;
const HISTORY_LIMIT = 60;

/** 数据库级毁灭性语句：直接拒绝（运维场景禁用） */
const FATAL_PATTERN = /^\s*drop\s+(database|schema)\b/i;

/** 拆分多语句：按分号切分（不处理字符串内分号的极端情况，内网可控场景够用） */
function splitStatements(sql) {
    return String(sql || '')
        .split(';')
        .map(s => s.trim())
        .filter(Boolean);
}

/** 执行历史：仅保留最近 HISTORY_LIMIT 条，避免本地库无限膨胀 */
function recordHistory(entry) {
    const state = store.load();
    if (!Array.isArray(state.sqlHistory)) state.sqlHistory = [];
    state.sqlHistory.unshift({ id: store.uid('q_'), ...entry });
    if (state.sqlHistory.length > 200) state.sqlHistory.length = 200;
    store.persist();
    return entry;
}

/**
 * 执行 SQL（多条）
 * @returns {{ok, source, statements, totalDurationMs}}
 */
async function executeSql(sourceId, sql) {
    const source = store.find('dbSources', sourceId);
    if (!source) return { ok: false, message: '数据源不存在' };

    const statements = splitStatements(sql);
    if (!statements.length) return { ok: false, message: '请输入要执行的 SQL' };
    if (statements.length > MAX_STATEMENTS) {
        return { ok: false, message: `单次最多执行 ${MAX_STATEMENTS} 条语句（当前 ${statements.length} 条）` };
    }

    const operator = (auth.getSession() || {}).username;

    // 安全校验先于连接校验：即使数据源不可用，毁灭性语句也必须被拒绝并留痕
    const fatal = statements.find(s => FATAL_PATTERN.test(s));
    if (fatal) {
        audit.write({
            type: '拦截', level: 'danger', user: operator,
            detail: `SQL 被拒绝执行（数据库级删除）：${fatal.slice(0, 120)}`, result: 'blocked'
        });
        recordHistory({
            sourceId, sourceName: source.name, type: source.type, user: operator,
            sql: String(sql).slice(0, 500), result: 'blocked', statementCount: statements.length,
            durationMs: 0, rowCount: 0, message: '已拦截：不允许执行 DROP DATABASE / DROP SCHEMA',
            createdAt: store.nowText()
        });
        return { ok: false, blocked: true, message: '已拦截：不允许执行 DROP DATABASE / DROP SCHEMA' };
    }

    if (!source.host || !source.user) {
        return { ok: false, message: '数据源未配置连接信息，请先在「数据库运维 → 数据库配置」中完成配置' };
    }
    if (source.enabled === false) {
        return { ok: false, message: `数据源「${source.name}」已停用，请先在「数据库配置」中启用` };
    }

    const started = Date.now();
    const results = [];
    for (const stmt of statements) {
        const t0 = Date.now();
        try {
            // eslint-disable-next-line no-await-in-loop
            const r = await dbAdapters.query(source, stmt);
            results.push({
                sql: stmt,
                columns: r.columns || [],
                rows: (r.rows || []).slice(0, MAX_ROWS),
                rowCount: (r.rows || []).length,
                truncated: (r.rows || []).length > MAX_ROWS,
                affectedRows: r.affectedRows,
                ok: true,
                durationMs: Date.now() - t0
            });
        } catch (err) {
            results.push({ sql: stmt, ok: false, error: err.message, durationMs: Date.now() - t0 });
            // 单条失败即中止后续语句（保持事务语义清晰）
            break;
        }
    }

    const totalDurationMs = Date.now() - started;
    const okCount = results.filter(r => r.ok).length;
    const rowCount = results.reduce((sum, r) => sum + (r.rowCount || 0), 0);
    const allOk = okCount === statements.length;

    audit.write({
        type: '命令', user: operator,
        detail: `在数据源「${source.name}」执行 SQL：${statements.length} 条（成功 ${okCount}）— ${String(sql).slice(0, 200)}`,
        result: allOk ? 'success' : 'failed'
    });

    recordHistory({
        sourceId, sourceName: source.name, type: source.type, user: operator,
        sql: String(sql).slice(0, 500), result: allOk ? 'success' : (okCount ? 'partial' : 'failed'),
        statementCount: statements.length, durationMs: totalDurationMs, rowCount,
        createdAt: store.nowText()
    });

    return {
        ok: allOk,
        partial: okCount > 0 && !allOk,
        source: { id: source.id, name: source.name, type: source.type },
        statements: results,
        totalDurationMs
    };
}

/** 结果集 → CSV 文本 */
function toCsv(columns, rows) {
    const escapeCell = (v) => {
        if (v === null || v === undefined) return '';
        const s = typeof v === 'object' ? JSON.stringify(v) : String(v);
        return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
    };
    const head = columns.map(escapeCell).join(',');
    const body = rows.map(row =>
        columns.map(c => escapeCell(Array.isArray(row) ? row[columns.indexOf(c)] : row[c])).join(',')
    ).join('\r\n');
    return head + '\r\n' + body;
}

function setup(ipcMain) {
    ipcMain.handle('sql:execute', (e, { sourceId, sql }) => executeSql(sourceId, sql));

    ipcMain.handle('sql:export', (e, { columns, rows, filename }) => {
        try {
            const content = toCsv(columns || [], rows || []);
            const stamp = store.nowText().replace(/[-: ]/g, '');
            return { ok: true, content, filename: filename || `sql-result-${stamp}.csv` };
        } catch (err) {
            return { ok: false, message: err.message };
        }
    });

    ipcMain.handle('db:tables', async (e, sourceId) => {
        const source = store.find('dbSources', sourceId);
        if (!source) return { ok: false, message: '数据源不存在' };
        try {
            const tables = await dbAdapters.listTables(source);
            return { ok: true, tables };
        } catch (err) {
            return { ok: false, message: err.message };
        }
    });

    ipcMain.handle('db:describe', async (e, { sourceId, table }) => {
        const source = store.find('dbSources', sourceId);
        if (!source) return { ok: false, message: '数据源不存在' };
        try {
            const columns = await dbAdapters.describeTable(source, table);
            return { ok: true, table, columns };
        } catch (err) {
            return { ok: false, message: err.message };
        }
    });

    /** 一次性返回全部表 + 结构（前端左侧树），失败时降级为逐表懒加载 */
    ipcMain.handle('db:schema', async (e, sourceId) => {
        const source = store.find('dbSources', sourceId);
        if (!source) return { ok: false, message: '数据源不存在' };
        try {
            const tables = await dbAdapters.listTables(source);
            const groups = [];
            for (const t of tables.slice(0, 200)) {
                try {
                    // eslint-disable-next-line no-await-in-loop
                    const columns = await dbAdapters.describeTable(source, t.name);
                    groups.push({ name: t.name, comment: t.comment || '', columns });
                } catch (err) {
                    groups.push({ name: t.name, comment: t.comment || '', columns: [], error: err.message });
                }
            }
            return { ok: true, groups };
        } catch (err) {
            return { ok: false, message: err.message };
        }
    });

    /* ---------------- SQL 脚本库 ---------------- */

    ipcMain.handle('sqlScripts:list', () => store.list('sqlScripts'));

    ipcMain.handle('sqlScripts:save', (e, payload) => {
        if (!String(payload.sql || '').trim()) return { ok: false, message: 'SQL 内容不能为空' };
        const data = { ...payload };
        const isNew = !data.id;
        data.updatedAt = store.nowText();
        data.author = data.author || (auth.getSession() || {}).username;
        if (isNew) data.createdAt = data.updatedAt;
        const saved = store.upsert('sqlScripts', data);
        audit.write({
            type: '操作', user: (auth.getSession() || {}).username,
            detail: `${isNew ? '保存' : '更新'} SQL 脚本「${saved.name}」`
        });
        return { ok: true, script: saved };
    });

    ipcMain.handle('sqlScripts:delete', (e, id) => {
        const script = store.find('sqlScripts', id);
        const ok = store.remove('sqlScripts', id);
        if (ok && script) {
            audit.write({ type: '操作', user: (auth.getSession() || {}).username, detail: `删除 SQL 脚本「${script.name}」` });
        }
        return { ok };
    });

    ipcMain.handle('sqlHistory:list', (e, { limit } = {}) =>
        store.list('sqlHistory').slice(0, limit || HISTORY_LIMIT));

    /* ---------------- 数据集成（ETL）----------------
       库对库 / 文件对库 / 库对文件，统一走「源 → 字段映射 → 目标」，
       详见 main/etl.js。写类通道为管理员专属（见 auth.ADMIN_ONLY）。
    */

    /** 源端采样：列清单（含推断类型）+ 样例行 + 总量 */
    ipcMain.handle('db:etl:preview', (e, { source, target } = {}) =>
        etl.previewSource(source || {}).then(res => {
            if (!res.ok || !target) return res;
            return etl.describeTarget(target).then(desc => ({
                ...res,
                targetTable: desc.table || null,
                targetColumns: desc.ok ? desc.columns : []
            }));
        }));

    /** 执行同步任务（支持 dryRun 试运行）；进度经 data:progress 推送 */
    ipcMain.handle('db:etl:run', async (event, { task } = {}) => {
        const send = payload => {
            if (!event.sender.isDestroyed()) event.sender.send('data:progress', payload);
        };
        try {
            const result = await etl.runEtl(task || {}, { onProgress: send });
            return result;
        } catch (err) {
            return { ok: false, message: err.message };
        }
    });

    /** 选择源/目标文件：返回路径，不把文件内容搬到渲染进程 */
    ipcMain.handle('db:etl:pickFile', (e, { kind } = {}) => etl.pickFile(kind || 'open'));

    ipcMain.handle('db:etl:tasks:list', () => etl.listTasks());

    ipcMain.handle('db:etl:tasks:save', (e, payload) => etl.saveTask(payload || {}));

    ipcMain.handle('db:etl:tasks:delete', (e, id) => etl.deleteTask(id));

    ipcMain.handle('db:etl:runs', (e, { limit } = {}) => etl.listRuns().slice(0, limit || 20));
}

module.exports = { setup, executeSql, splitStatements, toCsv, FATAL_PATTERN };
