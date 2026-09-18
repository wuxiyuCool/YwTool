/**
 * 总览页
 * 数据来源：dashboard:overview（统计 / 最近任务 / 安全告警）
 */
import { api, demoMode } from '../api.js';
import { esc, toast, demoBanner, emptyRow, loadingRow, shortTime } from '../ui.js';

const iconServer = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="2" y="4" width="20" height="6" rx="2"/><rect x="2" y="14" width="20" height="6" rx="2"/><line x1="6" y1="7" x2="6.01" y2="7"/><line x1="6" y1="17" x2="6.01" y2="17"/></svg>';
const iconPlay = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9"/><polygon points="10 8 16 12 10 16 10 8" fill="currentColor" stroke="none"/></svg>';
const iconShield = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3l8 3v6c0 5-3.5 8-8 9-4.5-1-8-4-8-9V6l8-3z"/></svg>';
const iconCode = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="8 6 3 12 8 18"/><polyline points="16 6 21 12 16 18"/></svg>';

const statusMap = {
    running: '<span class="badge blue">执行中</span>',
    success: '<span class="badge green">成功</span>',
    failed: '<span class="badge red">失败</span>',
    blocked: '<span class="badge amber">已拦截</span>'
};

const EMPTY = { hostTotal: '-', hostOnline: '-', hostOffline: '-', taskWeek: '-', taskSuccess: '-', taskFailed: '-', blocked: '-', ruleEnabled: '-', scriptTotal: '-', scriptShell: '-', scriptPython: '-' };

function statCards(s) {
    return [
        { label: '内网主机', value: s.hostTotal, sub: `在线 ${s.hostOnline} · 离线 ${s.hostOffline}`, icon: iconServer, cls: 'blue' },
        { label: '本周任务', value: s.taskWeek, sub: `成功 ${s.taskSuccess} · 失败 ${s.taskFailed}`, icon: iconPlay, cls: 'green' },
        { label: '拦截高危命令', value: s.blocked, sub: `生效规则 ${s.ruleEnabled} 条`, icon: iconShield, cls: 'red' },
        { label: '托管脚本', value: s.scriptTotal, sub: `Shell ${s.scriptShell} · Python ${s.scriptPython}`, icon: iconCode, cls: 'amber' }
    ];
}

function statsHtml(s) {
    return statCards(s).map(c => `
    <div class="stat-card">
        <div class="stat-info">
            <div class="stat-label">${c.label}</div>
            <div class="stat-value">${esc(c.value)}</div>
            <div class="stat-sub">${esc(c.sub)}</div>
        </div>
        <div class="stat-icon ${c.cls}">${c.icon}</div>
    </div>`).join('');
}

export function render() {
    return `
    ${demoBanner(demoMode)}
    <div class="stat-grid" id="dash-stats">${statsHtml(EMPTY)}</div>

    <div class="grid-2">
        <div class="card">
            <div class="card-header">
                <div>
                    <div class="card-title">最近任务</div>
                    <div class="card-desc">最近执行与调度记录（来自本地任务库）</div>
                </div>
                <button class="btn-link" data-goto="tasks">查看全部 →</button>
            </div>
            <div class="table-wrap">
                <table class="table">
                    <thead><tr><th>任务 ID</th><th>命令 / 脚本</th><th>主机数</th><th>状态</th><th>时间</th><th>操作人</th></tr></thead>
                    <tbody id="dash-tasks">${loadingRow(6)}</tbody>
                </table>
            </div>
        </div>

        <div class="card">
            <div class="card-header">
                <div>
                    <div class="card-title">安全告警</div>
                    <div class="card-desc">拦截记录与异常事件（来自审计日志）</div>
                </div>
                <button class="btn-link" data-goto="audit">审计日志 →</button>
            </div>
            <div id="dash-alerts">${loadingRow(1, '加载中...')}</div>
        </div>
    </div>`;
}

export async function mount(root) {
    try {
        const data = await api.dashboard.overview();

        root.querySelector('#dash-stats').innerHTML = statsHtml(data.stats || EMPTY);

        const tasks = data.recentTasks || [];
        root.querySelector('#dash-tasks').innerHTML = tasks.length ? tasks.map(t => `
            <tr>
                <td class="mono">${esc(t.id)}</td>
                <td class="mono" style="max-width:260px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap" title="${esc(t.cmd)}">${esc(t.cmd)}</td>
                <td>${esc(t.hostCount)}</td>
                <td>${statusMap[t.status] || esc(t.status)}</td>
                <td class="muted">${esc(shortTime(t.createdAt))}</td>
                <td>${esc(t.operator)}</td>
            </tr>`).join('') : emptyRow(6, '暂无任务记录');

        const alerts = data.alerts || [];
        root.querySelector('#dash-alerts').innerHTML = alerts.length ? alerts.map(a => `
            <div class="alert ${a.level === 'danger' ? 'danger' : a.level === 'warn' ? 'warn' : 'info'}" style="margin-bottom:10px">
                <span class="mono muted" style="flex-shrink:0">${esc(a.time || '')}</span>
                <span>${esc(a.text)}</span>
            </div>`).join('') : '<div class="empty">暂无安全告警</div>';
    } catch (err) {
        toast('总览数据加载失败：' + err.message, 'danger');
        root.querySelector('#dash-tasks').innerHTML = emptyRow(6, '数据加载失败');
        root.querySelector('#dash-alerts').innerHTML = '<div class="empty">数据加载失败</div>';
    }
}
