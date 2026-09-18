/**
 * 日志审计页
 * 数据流：audit:query（按类型/结果/关键字过滤，读取本地日志文件）
 *        audit:stats / audit:paths（日志位置） / audit:cleanup（按保留天数清理）
 */
import { api, demoMode } from '../api.js';
import { esc, toast, demoBanner, emptyRow, loadingRow } from '../ui.js';

const typeBadge = t =>
    ({ 拦截: '<span class="badge red">拦截</span>', 告警: '<span class="badge amber">告警</span>', 命令: '<span class="badge blue">命令</span>', 操作: '<span class="badge gray">操作</span>', 登录: '<span class="badge green">登录</span>' }[t] || esc(t));

const resultBadge = r =>
    ({ success: '<span class="badge green">成功</span>', blocked: '<span class="badge amber">已拦截</span>', failed: '<span class="badge red">失败</span>' }[r] || esc(r));

let records = [];

function rowHtml(l) {
    return `
    <tr>
        <td class="mono muted">${esc(l.time)}</td>
        <td>${typeBadge(l.type)}</td>
        <td>${esc(l.user)}</td>
        <td class="mono muted">${esc(l.source)}</td>
        <td>${esc(l.detail)}</td>
        <td>${resultBadge(l.result)}</td>
    </tr>`;
}

export function render() {
    return `
    ${demoBanner(demoMode)}
    <div class="stat-grid">
        <div class="stat-card">
            <div class="stat-info">
                <div class="stat-label">今日记录</div>
                <div class="stat-value" id="audit-total">-</div>
                <div class="stat-sub" id="audit-files">日志文件 - 个</div>
            </div>
            <div class="stat-icon blue"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M14 3H6a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9z"/><polyline points="14 3 14 9 20 9"/></svg></div>
        </div>
        <div class="stat-card">
            <div class="stat-info">
                <div class="stat-label">今日拦截</div>
                <div class="stat-value" id="audit-blocked">-</div>
                <div class="stat-sub">命中敏感规则并阻止执行</div>
            </div>
            <div class="stat-icon red"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 3l8 3v6c0 5-3.5 8-8 9-4.5-1-8-4-8-9V6l8-3z"/></svg></div>
        </div>
        <div class="stat-card">
            <div class="stat-info">
                <div class="stat-label">今日失败</div>
                <div class="stat-value" id="audit-failed">-</div>
                <div class="stat-sub">命令执行 / 连接异常</div>
            </div>
            <div class="stat-icon amber"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/></svg></div>
        </div>
    </div>

    <div class="card">
        <div class="toolbar">
            <select class="select" id="audit-type">
                <option value="all">全部类型</option>
                <option value="拦截">拦截</option>
                <option value="告警">告警</option>
                <option value="命令">命令</option>
                <option value="操作">操作</option>
                <option value="登录">登录</option>
            </select>
            <select class="select" id="audit-result">
                <option value="all">全部结果</option>
                <option value="success">成功</option>
                <option value="blocked">已拦截</option>
                <option value="failed">失败</option>
            </select>
            <input class="input" id="audit-search" placeholder="关键字（用户 / 内容）..." style="width:200px">
            <button class="btn btn-ghost btn-sm" id="btn-audit-query">查询</button>
            <div class="spacer"></div>
            <button class="btn btn-ghost btn-sm" id="btn-audit-export">导出 CSV</button>
            <button class="btn btn-ghost btn-sm" id="btn-audit-cleanup">清理过期日志</button>
        </div>

        <div class="table-wrap">
            <table class="table">
                <thead><tr><th style="width:170px">时间</th><th>类型</th><th>用户</th><th>来源</th><th>内容</th><th>结果</th></tr></thead>
                <tbody id="audit-tbody">${loadingRow(6)}</tbody>
            </table>
        </div>
        <div class="card-desc" style="margin-top:14px" id="audit-path">日志位置加载中...</div>
    </div>`;
}

export async function mount(root) {
    const tbody = root.querySelector('#audit-tbody');

    const loadStats = async () => {
        try {
            const s = await api.audit.stats();
            root.querySelector('#audit-total').textContent = s.todayTotal;
            root.querySelector('#audit-blocked').textContent = s.todayBlocked;
            root.querySelector('#audit-failed').textContent = s.todayFailed;
            root.querySelector('#audit-files').textContent = `日志文件 ${s.files} 个`;
        } catch (err) { /* 忽略 */ }
    };

    const loadPaths = async () => {
        try {
            const p = await api.audit.paths();
            root.querySelector('#audit-path').innerHTML =
                `日志目录：<span class="mono">${esc(p.logDir)}</span> · 今日文件：<span class="mono">${esc(p.today)}</span>`;
        } catch (err) { /* 忽略 */ }
    };

    const query = async () => {
        tbody.innerHTML = loadingRow(6);
        try {
            const res = await api.audit.query({
                type: root.querySelector('#audit-type').value,
                result: root.querySelector('#audit-result').value,
                keyword: root.querySelector('#audit-search').value,
                limit: 300
            });
            records = (res && res.records) || [];
            tbody.innerHTML = records.length ? records.map(rowHtml).join('') : emptyRow(6, '没有符合条件的审计记录');
        } catch (err) {
            tbody.innerHTML = emptyRow(6, '审计查询失败：' + err.message);
        }
    };

    root.querySelector('#btn-audit-query').addEventListener('click', async () => { await query(); await loadStats(); });
    root.querySelector('#audit-type').addEventListener('change', query);
    root.querySelector('#audit-result').addEventListener('change', query);
    root.querySelector('#audit-search').addEventListener('input', () => {
        clearTimeout(root._kwTimer);
        root._kwTimer = setTimeout(query, 300);
    });

    root.querySelector('#btn-audit-export').addEventListener('click', () => {
        if (!records.length) { toast('当前没有可导出的记录', 'warn'); return; }
        const header = '时间,类型,用户,来源,内容,结果\n';
        const body = records.map(r => [r.time, r.type, r.user, r.source, JSON.stringify(r.detail), r.result].join(',')).join('\n');
        const blob = new Blob(['\ufeff' + header + body], { type: 'text/csv;charset=utf-8' });
        const a = document.createElement('a');
        a.href = URL.createObjectURL(blob);
        a.download = `audit-${new Date().toISOString().slice(0, 10)}.csv`;
        a.click();
        URL.revokeObjectURL(a.href);
        toast('审计记录已导出', 'success');
    });

    root.querySelector('#btn-audit-cleanup').addEventListener('click', async () => {
        const config = await api.system.getConfig().catch(() => null);
        const days = (config && config.logRetentionDays) || 180;
        if (!confirm(`按保留策略清理 ${days} 天前的日志文件？（清理动作本身也会记入审计）`)) return;
        const res = await api.audit.cleanup(days);
        toast(res && res.ok ? `已清理 ${res.removed} 个日志文件` : '清理失败', res && res.ok ? 'success' : 'danger');
        await loadStats();
    });

    await Promise.all([query(), loadStats(), loadPaths()]);
}
