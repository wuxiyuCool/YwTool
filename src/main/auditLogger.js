/**
 * 审计日志 · 每日一个 JSON Lines 文件
 * 位置：<userData>/logs/audit-YYYY-MM-DD.log
 * 说明：当前阶段本地文件留痕，后期可扩展写入远程数据库表
 */
const fs = require('fs');
const path = require('path');
const { LOG_DIR, ensureDirs, nowText } = require('./store');

const TYPE_LEVEL = { 拦截: 'danger', 告警: 'warn', 命令: 'info', 操作: 'info', 登录: 'info' };

function dayStamp(d = new Date()) {
    const p = n => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

function logFilePath(day) {
    return path.join(LOG_DIR, `audit-${day || dayStamp()}.log`);
}

/**
 * 写入一条审计记录（追加，永不修改历史）
 * @param {{type:string,user?:string,source?:string,detail:string,result?:string}} entry
 */
function write(entry) {
    ensureDirs();
    const record = {
        time: nowText(),
        type: entry.type || '操作',
        level: entry.level || TYPE_LEVEL[entry.type] || 'info',
        user: entry.user || 'admin',
        source: entry.source || '本机',
        detail: entry.detail || '',
        result: entry.result || 'success'
    };
    fs.appendFileSync(logFilePath(), JSON.stringify(record) + '\n', 'utf8');
    return record;
}

/** 列出所有日志文件（新→旧） */
function listFiles() {
    ensureDirs();
    return fs.readdirSync(LOG_DIR)
        .filter(f => /^audit-\d{4}-\d{2}-\d{2}\.log$/.test(f))
        .sort()
        .reverse()
        .map(f => path.join(LOG_DIR, f));
}

/**
 * 查询审计日志（倒序返回）
 * @param {{type?:string,result?:string,keyword?:string,limit?:number}} query
 */
function query(query = {}) {
    const { type = 'all', result = 'all', keyword = '', limit = 200 } = query;
    const kw = String(keyword || '').trim().toLowerCase();
    const out = [];

    for (const file of listFiles()) {
        const lines = fs.readFileSync(file, 'utf8').split('\n').filter(Boolean);
        for (let i = lines.length - 1; i >= 0; i--) {
            let rec;
            try { rec = JSON.parse(lines[i]); } catch (e) { continue; }
            if (type !== 'all' && rec.type !== type) continue;
            if (result !== 'all' && rec.result !== result) continue;
            if (kw && !(rec.user + rec.detail).toLowerCase().includes(kw)) continue;
            out.push(rec);
            if (out.length >= limit) return out;
        }
    }
    return out;
}

/** 审计概览统计 */
function stats() {
    const todayFile = logFilePath();
    const today = fs.existsSync(todayFile)
        ? fs.readFileSync(todayFile, 'utf8').split('\n').filter(Boolean)
            .map(l => { try { return JSON.parse(l); } catch (e) { return null; } })
            .filter(Boolean)
        : [];
    return {
        todayTotal: today.length,
        todayBlocked: today.filter(r => r.result === 'blocked').length,
        todayFailed: today.filter(r => r.result === 'failed').length,
        files: listFiles().length
    };
}

/** 清理超出保留天数的日志文件 */
function cleanup(retentionDays) {
    const days = Number(retentionDays) || 180;
    const limit = Date.now() - days * 86400000;
    let removed = 0;
    for (const file of listFiles()) {
        const day = path.basename(file).replace('audit-', '').replace('.log', '');
        if (new Date(day + 'T00:00:00').getTime() < limit) {
            fs.unlinkSync(file);
            removed++;
        }
    }
    return removed;
}

module.exports = { write, query, stats, listFiles, logFilePath, cleanup, LOG_DIR, dayStamp, nowText };
