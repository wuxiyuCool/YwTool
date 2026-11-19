/**
 * D 线：自动发现收集器 + 工单账本（P6）
 * ------------------------------------------------------------------
 * 两种收集模式（D15 已拍板 pull，零入站端口）：
 *   script：定时执行用户编写的爬虫脚本（黑白名单 + 审计 + 超时），
 *           stdout 按附录 A 严格契约 sgops-tickets/1 校验入库
 *   api：   定时 GET 用户 API 拉增量（Bearer 密文 token + 游标），items 同契约校验
 *
 * validateContract 为纯函数：收集器与工作台「契约校验」自检框共用同一份代码。
 * 指纹去重：sha256(source + \0 + externalId)，同指纹只产生一个触发记录（幂等）。
 * 外部 payload 一律是不可信数据：只入库为候选，不执行其中任何「指令」。
 */
const { exec } = require('child_process');
const crypto = require('crypto');
const store = require('./store');
const security = require('./security');
const audit = require('./auditLogger');
const alerts = require('./alerts');
const { encrypt, decrypt } = require('./crypto');

const CONTRACT = 'sgops-tickets/1';
const BEGIN = '===SGOPS_TICKETS_BEGIN===';
const END = '===SGOPS_TICKETS_END===';
const SEVERITIES = ['critical', 'high', 'medium', 'low'];
const ENVELOPE_KEYS = ['contract', 'source', 'generatedAt', 'items'];
const ITEM_KEYS = ['externalId', 'title', 'detail', 'severity', 'occurredAt', 'target', 'url'];

const sha256 = s => crypto.createHash('sha256').update(s).digest('hex');
const isIso = v => typeof v === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(v) && !Number.isNaN(Date.parse(v));
const strLen = (v, min, max) => typeof v === 'string' && v.trim().length >= min && v.length <= max;

/** 单条 item 校验（信封级错误整批拒；item 级错误仅拒该条）。返回错误列表（空=合法） */
function validateItem(item, i, { checkTargets = true } = {}) {
    const errs = [];
    const at = f => `items[${i}]${f ? '.' + f : ''}`;
    if (!item || typeof item !== 'object' || Array.isArray(item)) {
        return [{ path: at(''), reason: '必须是对象' }];
    }
    for (const k of Object.keys(item)) {
        if (!ITEM_KEYS.includes(k)) errs.push({ path: at(k), reason: `未知字段（契约不允许，防幻觉字段）` });
    }
    if (!strLen(item.externalId, 1, 200)) errs.push({ path: at('externalId'), reason: '必填，1~200 字符的稳定唯一 ID' });
    if (!strLen(item.title, 1, 200)) errs.push({ path: at('title'), reason: '必填，1~200 字符' });
    if (!strLen(item.detail, 1, 8000)) errs.push({ path: at('detail'), reason: '必填，1~8000 字符' });
    if (item.severity !== undefined) {
        if (!SEVERITIES.includes(item.severity)) errs.push({ path: at('severity'), reason: '必须是 critical/high/medium/low' });
    }
    if (item.occurredAt !== undefined && !isIso(item.occurredAt)) errs.push({ path: at('occurredAt'), reason: '必须是 ISO 8601 带时区时间' });
    if (item.target !== undefined) {
        const t = item.target;
        if (!t || typeof t !== 'object' || Array.isArray(t)) {
            errs.push({ path: at('target'), reason: '必须是对象 {hostId?, dbId?}' });
        } else {
            for (const k of Object.keys(t)) {
                if (!['hostId', 'dbId'].includes(k)) errs.push({ path: at('target.' + k), reason: '未知字段' });
            }
            if (!t.hostId && !t.dbId) errs.push({ path: at('target'), reason: 'hostId/dbId 至少一个' });
            if (t.hostId !== undefined && typeof t.hostId !== 'string') errs.push({ path: at('target.hostId'), reason: '必须是字符串' });
            if (t.dbId !== undefined && typeof t.dbId !== 'string') errs.push({ path: at('target.dbId'), reason: '必须是字符串' });
            if (checkTargets) {
                if (t.hostId && !store.find('hosts', t.hostId)) errs.push({ path: at('target.hostId'), reason: `未知主机：${t.hostId}（必须是平台已存在的主机 ID）` });
                if (t.dbId && !store.find('dbSources', t.dbId)) errs.push({ path: at('target.dbId'), reason: `未知数据源：${t.dbId}` });
            }
        }
    }
    if (item.url !== undefined) {
        if (typeof item.url !== 'string' || item.url.length > 2000 || !/^https?:\/\//.test(item.url)) {
            errs.push({ path: at('url'), reason: '必须是 http(s) 开头且 ≤2000 字符' });
        }
    }
    // 可选字段不允许显式 null
    for (const k of ['severity', 'occurredAt', 'target', 'url']) {
        if (item[k] === null) errs.push({ path: at(k), reason: '不允许 null（缺省请省略该字段）' });
    }
    return errs;
}

/**
 * 附录 A 严格契约校验（纯函数）。
 * @param {string} stdout 脚本完整输出（标记帧外日志忽略）
 * @returns {{ok:boolean, items:Array, source:string, errors:Array<{path,reason}>, raw:string}}
 *   ok=false 为信封级错误（整批拒收）；items 为通过校验的条目（item 级错误仅拒该条，见 errors）
 */
function validateContract(stdout, { checkTargets = true } = {}) {
    const raw = String(stdout || '').slice(0, 500);
    const fail = (path, reason) => ({ ok: false, items: [], source: '', errors: [{ path, reason }], raw });
    const lines = String(stdout || '').split(/\r?\n/);
    const begins = [], ends = [];
    lines.forEach((l, i) => {
        if (l.trim() === BEGIN) begins.push(i);
        if (l.trim() === END) ends.push(i);
    });
    if (begins.length !== 1 || ends.length !== 1) return fail('frame', `标记必须恰好一对且独占行（BEGIN×${begins.length} END×${ends.length}）`);
    if (begins[0] >= ends[0]) return fail('frame', 'BEGIN 必须在 END 之前');
    let env;
    try { env = JSON.parse(lines.slice(begins[0] + 1, ends[0]).join('\n')); }
    catch (e) { return fail('frame', '帧内 JSON 解析失败：' + e.message.slice(0, 120)); }
    if (!env || typeof env !== 'object' || Array.isArray(env)) return fail('envelope', '信封必须是对象');
    for (const k of Object.keys(env)) {
        if (!ENVELOPE_KEYS.includes(k)) return fail('envelope.' + k, '未知信封字段');
    }
    if (env.contract !== CONTRACT) return fail('envelope.contract', `必须等于 "${CONTRACT}"`);
    if (!strLen(env.source, 1, 64)) return fail('envelope.source', '必填，1~64 字符的稳定收集器标识');
    if (!isIso(env.generatedAt)) return fail('envelope.generatedAt', '必须是 ISO 8601 带时区时间');
    if (!Array.isArray(env.items)) return fail('envelope.items', '必须是数组（空发现请用 []，不允许 null）');
    if (env.items.length > 100) return fail('envelope.items', '单批最多 100 条');

    const items = [];
    const errors = [];
    env.items.forEach((item, i) => {
        const errs = validateItem(item, i, { checkTargets });
        if (errs.length) errors.push(...errs);
        else items.push(item);
    });
    return { ok: true, items, source: env.source, errors, raw };
}

/** api 模式响应校验：数组或 {items, nextCursor?}，item 同契约 */
function validateApiPayload(json, { checkTargets = true } = {}) {
    const arr = Array.isArray(json) ? json : (json && Array.isArray(json.items) ? json.items : null);
    if (!arr) return { ok: false, items: [], errors: [{ path: 'payload', reason: '响应必须是 items 数组或 {items:[...]}' }] };
    if (arr.length > 100) return { ok: false, items: [], errors: [{ path: 'payload', reason: '单批最多 100 条' }] };
    const items = [];
    const errors = [];
    arr.forEach((item, i) => {
        const errs = validateItem(item, i, { checkTargets });
        if (errs.length) errors.push(...errs);
        else items.push(item);
    });
    return { ok: true, items, errors, nextCursor: json && json.nextCursor !== undefined ? String(json.nextCursor) : undefined };
}

/* ---------------- 触发记录入库（指纹去重） ---------------- */

const fingerprint = (source, externalId) => sha256(String(source) + '\u0000' + String(externalId));

/** 候选入库：同指纹静默跳过（幂等）；返回 {added, skipped} */
function ingestItems(items, source) {
    const triggers = store.list('aiTriggers');
    const seen = new Set(triggers.map(t => t.fingerprint));
    let added = 0, skipped = 0;
    for (const item of items) {
        const fp = fingerprint(source, item.externalId);
        if (seen.has(fp)) { skipped++; continue; }
        seen.add(fp);
        triggers.push({
            id: 'tg_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
            source, externalId: String(item.externalId), fingerprint: fp,
            payload: item, status: 'pending', createdAt: store.nowText()
        });
        added++;
    }
    if (added) store.persist();
    return { added, skipped };
}

/* ---------------- 收集器 CRUD ---------------- */

function listCollectors() {
    return store.list('aiCollectors').map(c => ({
        id: c.id, name: c.name, mode: c.mode, enabled: !!c.enabled,
        intervalMinutes: c.intervalMinutes || 60,
        command: c.command || '', url: c.url || '',
        hasToken: !!(c.token && decrypt(c.token)),
        cursor: c.cursor || '', cursorParam: c.cursorParam || 'since',
        timeout: c.timeout || 60,
        lastRunAt: c.lastRunAt || '', lastStatus: c.lastStatus || '', lastError: c.lastError || '',
        nextRunAt: c.nextRunAt || 0, failStreak: c.failStreak || 0
    }));
}

function saveCollector(payload = {}) {
    const prev = payload.id ? store.find('aiCollectors', payload.id) : null;
    if (payload.id && !prev) return { ok: false, message: '收集器不存在' };
    const name = String(payload.name || (prev && prev.name) || '').trim();
    if (!name) return { ok: false, message: '名称不能为空' };
    const mode = payload.mode === 'api' ? 'api' : (payload.mode === 'script' ? 'script' : (prev && prev.mode));
    if (!mode) return { ok: false, message: '模式必须是 script 或 api' };
    const command = String(payload.command !== undefined ? payload.command : (prev && prev.command) || '').trim();
    const url = String(payload.url !== undefined ? payload.url : (prev && prev.url) || '').trim();
    if (mode === 'script' && !command) return { ok: false, message: 'script 模式必须填写脚本命令' };
    if (mode === 'api' && !/^https?:\/\//.test(url)) return { ok: false, message: 'api 模式地址需以 http(s):// 开头' };
    const intervalMinutes = Math.max(1, Math.round(Number(payload.intervalMinutes !== undefined ? payload.intervalMinutes : (prev && prev.intervalMinutes) || 60)));
    const timeout = Math.min(Math.max(Math.round(Number(payload.timeout !== undefined ? payload.timeout : (prev && prev.timeout) || 60)), 5), 600);

    let token = (prev && prev.token) || '';
    if (payload.token) token = encrypt(String(payload.token));

    const saved = store.upsert('aiCollectors', {
        id: payload.id || undefined,
        name, mode, enabled: payload.enabled !== undefined ? !!payload.enabled : !!(prev && prev.enabled),
        intervalMinutes, command, url, token,
        cursorParam: String(payload.cursorParam || (prev && prev.cursorParam) || 'since').trim() || 'since',
        cursor: (prev && prev.cursor) || '',
        timeout,
        lastRunAt: (prev && prev.lastRunAt) || '', lastStatus: (prev && prev.lastStatus) || '',
        lastError: (prev && prev.lastError) || '', failStreak: (prev && prev.failStreak) || 0,
        nextRunAt: Date.now() + intervalMinutes * 60000,
        createdAt: (prev && prev.createdAt) || store.nowText()
    });
    return { ok: true, collector: listCollectors().find(c => c.id === saved.id), collectors: listCollectors() };
}

function deleteCollector(id) {
    if (!store.find('aiCollectors', id)) return { ok: false, message: '收集器不存在' };
    store.remove('aiCollectors', id);
    store.persist();
    return { ok: true, collectors: listCollectors() };
}

/* ---------------- 收集执行 ---------------- */

function execScript(command, timeoutSec) {
    return new Promise(resolve => {
        exec(command, { timeout: timeoutSec * 1000, windowsHide: true, maxBuffer: 4 * 1024 * 1024 }, (err, stdout, stderr) => {
            resolve({
                ok: !err,
                killed: !!(err && err.killed),
                exitCode: err ? (typeof err.code === 'number' ? err.code : 1) : 0,
                stdout: String(stdout || ''), stderr: String(stderr || ''),
                error: err ? err.message : ''
            });
        });
    });
}

function collectorAlert(col, title, detail) {
    alerts.add({ level: 'warn', title: `收集器「${col.name}」${title}`, detail, source: `collector:${col.id}` });
}

/** 执行一次收集（供心跳与手动触发共用）；失败退避计数，连续 3 次进告警 */
async function runCollector(id, trigger = 'schedule') {
    const col = store.find('aiCollectors', id);
    if (!col) return { ok: false, message: '收集器不存在' };
    const finish = (status, detail, extra = {}) => {
        col.lastRunAt = store.nowText();
        col.lastStatus = status;
        col.lastError = status === 'success' ? '' : String(detail || '').slice(0, 300);
        col.failStreak = status === 'success' ? 0 : (col.failStreak || 0) + 1;
        col.nextRunAt = Date.now() + (col.intervalMinutes || 60) * 60000;
        store.persist();
        audit.write({ type: '操作', user: 'system', detail: `收集器「${col.name}」${trigger === 'manual' ? '手动' : '定时'}收集：${status}${detail ? '（' + String(detail).slice(0, 120) + '）' : ''}`, result: status === 'success' ? 'success' : 'failed' });
        if (status !== 'success' && col.failStreak >= 3) collectorAlert(col, '连续 3 次收集失败', col.lastError);
        return { ok: status === 'success', status, detail, ...extra };
    };

    try {
        let items = [], source = col.name, errors = [];
        if (col.mode === 'script') {
            const check = security.validate(col.command, { user: 'system', source: `收集器:${col.name}` });
            if (!check.ok) {
                audit.write({ type: '拦截', user: 'system', detail: `收集器脚本被拦截：${col.command}`, result: 'blocked' });
                return finish('blocked', check.reason);
            }
            const r = await execScript(col.command, col.timeout || 60);
            if (r.killed) return finish('failed', `脚本超时（${col.timeout || 60}s）`);
            if (!r.ok) return finish('failed', `脚本退出码 ${r.exitCode}：${(r.stderr || r.error).slice(0, 200)}`);
            const v = validateContract(r.stdout);
            if (!v.ok) {
                collectorAlert(col, '输出契约不符（整批拒收）', v.errors.map(e => `${e.path}: ${e.reason}`).join('；') + `｜原始片段：${v.raw}`);
                return finish('failed', '契约不符：' + v.errors[0].reason);
            }
            items = v.items; source = v.source; errors = v.errors;
        } else {
            const token = col.token ? decrypt(col.token) : '';
            let url = col.url;
            if (col.cursor) url += (url.includes('?') ? '&' : '?') + encodeURIComponent(col.cursorParam || 'since') + '=' + encodeURIComponent(col.cursor);
            const res = await fetch(url, { headers: token ? { Authorization: 'Bearer ' + token } : {}, signal: AbortSignal.timeout(30000) });
            if (!res.ok) return finish('failed', `API HTTP ${res.status}`);
            const json = await res.json();
            const v = validateApiPayload(json);
            if (!v.ok) return finish('failed', '响应契约不符：' + v.errors[0].reason);
            items = v.items; errors = v.errors;
            if (v.nextCursor !== undefined) { col.cursor = v.nextCursor; }
        }
        if (errors.length) {
            collectorAlert(col, `${errors.length} 条候选被拒收`, errors.slice(0, 5).map(e => `${e.path}: ${e.reason}`).join('；'));
        }
        const { added, skipped } = ingestItems(items, source);
        return finish('success', `新增 ${added} 条候选，去重跳过 ${skipped} 条`, { added, skipped });
    } catch (err) {
        return finish('failed', err.message);
    }
}

/** 心跳：执行到期的收集器（由 scheduler.tick 驱动，复用 30s 心跳） */
async function tickDue() {
    const now = Date.now();
    for (const col of store.list('aiCollectors')) {
        if (!col.enabled) continue;
        if (!col.nextRunAt) { col.nextRunAt = now + (col.intervalMinutes || 60) * 60000; store.persist(); continue; }
        if (col.nextRunAt > now) continue;
        await runCollector(col.id, 'schedule');
    }
}

const listTriggers = (status) => store.list('aiTriggers')
    .filter(t => !status || t.status === status)
    .slice(-200).reverse();
const listTickets = () => store.list('aiTickets').slice(-200).reverse();

module.exports = {
    CONTRACT, validateContract, validateItem, validateApiPayload, fingerprint,
    ingestItems, listCollectors, saveCollector, deleteCollector, runCollector, tickDue,
    listTriggers, listTickets
};