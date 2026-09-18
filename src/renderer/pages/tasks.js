/**
 * 任务执行页
 * 数据流：
 *   目标主机 ← hosts:list
 *   运行参数 ← system:config:get（并发上限 / 超时）
 *   执行前校验 ← tasks:validate（命中敏感规则直接拦截）
 *   提交执行 ← tasks:run（主进程并发 SSH，实时推送 task:progress）
 *   历史与结果 ← tasks:list / tasks:detail / tasks:export
 *   定时调度 ← schedules:list|save|toggle|delete|runNow（主进程调度器 30s 心跳）
 */
import { api, demoMode } from '../api.js';
import { esc, toast, demoBanner, emptyRow, loadingRow, shortTime, guardWrite, guardAdmin, applyReadonly } from '../ui.js';

let hosts = [];
let scripts = [];
let history = [];
let schedules = [];
let lastSelected = [];
let editingScheduleId = null;

const statusMap = {
    running: '<span class="badge blue">执行中</span>',
    success: '<span class="badge green">成功</span>',
    failed: '<span class="badge red">失败</span>',
    blocked: '<span class="badge amber">已拦截</span>'
};

const lastStatusMap = {
    running: '<span class="badge blue">执行中</span>',
    success: '<span class="badge green">成功</span>',
    failed: '<span class="badge red">失败</span>',
    blocked: '<span class="badge amber">已拦截</span>'
};

/** 调度的执行内容描述 */
function describeTarget(s) {
    if (s.scriptId) {
        const script = scripts.find(x => x.id === s.scriptId);
        return `[脚本] ${script ? script.name : s.scriptId}`;
    }
    return s.cmd || '-';
}

function scheduleRow(s) {
    return `
    <tr data-id="${esc(s.id)}">
        <td><strong>${esc(s.name)}</strong></td>
        <td>${esc(s.scheduleText || '')}</td>
        <td class="mono" style="max-width:240px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap" title="${esc(describeTarget(s))}">${esc(describeTarget(s))}</td>
        <td>${esc((s.hostIds || []).length)} 台</td>
        <td class="muted">${esc(s.nextRunText || '-')}</td>
        <td class="muted">${esc(shortTime(s.lastRunAt)) || '-'} ${s.lastStatus ? lastStatusMap[s.lastStatus] || '' : ''}</td>
        <td>
            <label class="switch">
                <input type="checkbox" data-toggle="${esc(s.id)}" ${s.enabled ? 'checked' : ''} data-write>
                <span class="track"></span>
            </label>
        </td>
        <td style="white-space:nowrap">
            <button class="btn-link" data-act="run" data-write>立即执行</button>
            <button class="btn-link" data-act="edit" data-write>编辑</button>
            <button class="btn-link danger" data-act="delete" data-write>删除</button>
        </td>
    </tr>`;
}

function historyHtml() {
    return history.length ? history.map(t => `
    <tr>
        <td class="mono">${esc(t.id)}</td>
        <td class="mono" style="max-width:320px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap" title="${esc(t.cmd)}">${esc(t.cmd)}</td>
        <td>${esc(t.hostCount)}</td>
        <td>${statusMap[t.status] || esc(t.status)}</td>
        <td class="muted">${esc(shortTime(t.createdAt))}</td>
        <td>${esc(t.operator)}</td>
        <td style="white-space:nowrap">
            <button class="btn-link" data-detail="${esc(t.id)}">查看结果</button>
            <button class="btn-link" data-export="${esc(t.id)}">导出</button>
        </td>
    </tr>`).join('') : emptyRow(7, '暂无执行记录');
}

export function render() {
    return `
    ${demoBanner(demoMode)}
    <div class="card">
        <div class="card-header">
            <div>
                <div class="card-title">批量执行</div>
                <div class="card-desc">命令/脚本先经敏感词规则校验，命中高危规则会被直接拦截并记录审计</div>
            </div>
        </div>

        <div class="form-item" style="margin-bottom:14px">
            <label>目标主机（已选 <span id="host-count">0</span> / <span id="host-total">0</span> 台）
                <button class="btn-link" id="btn-select-all">全选</button>
                <button class="btn-link" id="btn-select-none">清空</button>
            </label>
            <div class="check-grid" id="target-grid">${loadingRow(1, '主机加载中...')}</div>
        </div>

        <div class="form-row" style="margin-bottom:14px">
            <div class="form-item">
                <label>执行方式</label>
                <select class="select" id="exec-mode" style="width:100%">
                    <option value="cmd">直接执行命令</option>
                    <option value="script">执行托管脚本</option>
                </select>
            </div>
            <div class="form-item" id="field-script" style="display:none">
                <label>选择脚本</label>
                <select class="select" id="script-select" style="width:100%"></select>
            </div>
            <div class="form-item">
                <label>并发数（默认取系统配置）</label>
                <input class="input" id="concurrency" type="number" min="1" max="50" value="10">
            </div>
            <div class="form-item">
                <label>超时时间（秒）</label>
                <input class="input" id="timeout" type="number" min="5" max="600" value="30">
            </div>
        </div>

        <div class="form-item" id="field-cmd" style="margin-bottom:14px">
            <label>执行命令</label>
            <textarea class="textarea" id="cmd-input" rows="3" placeholder="例如：df -h &amp;&amp; free -m">df -h</textarea>
        </div>

        <div id="validate-result"></div>
        <div id="progress-area"></div>

        <div class="toolbar" style="margin:14px 0 0">
            <button class="btn btn-ghost" id="btn-validate">执行前校验</button>
            <div class="spacer"></div>
            <button class="btn btn-primary" id="btn-execute" data-write>开始执行</button>
        </div>
    </div>

    <div class="card">
        <div class="card-header">
            <div>
                <div class="card-title">定时任务</div>
                <div class="card-desc">按周期自动重复执行，与手动执行走完全一致的安全校验与审计链路；未安装 ssh2 时会生成失败告警</div>
            </div>
            <div style="display:flex;gap:8px">
                <button class="btn btn-ghost btn-sm" id="btn-reload-schedules">刷新</button>
                <button class="btn btn-primary btn-sm" id="btn-add-schedule" data-write>+ 新增定时任务</button>
            </div>
        </div>
        <div class="table-wrap">
            <table class="table">
                <thead><tr><th>任务名</th><th>周期</th><th>执行内容</th><th>目标主机</th><th>下次执行</th><th>上次执行</th><th>启用</th><th>操作</th></tr></thead>
                <tbody id="schedule-tbody">${loadingRow(8)}</tbody>
            </table>
        </div>
    </div>

    <div class="card">
        <div class="card-header">
            <div>
                <div class="card-title">执行历史</div>
                <div class="card-desc">全部任务留痕，可查看逐台主机输出并导出 CSV</div>
            </div>
            <button class="btn btn-ghost btn-sm" id="btn-reload-history">刷新</button>
        </div>
        <div class="table-wrap">
            <table class="table">
                <thead><tr><th>任务 ID</th><th>命令 / 脚本</th><th>主机数</th><th>状态</th><th>时间</th><th>操作人</th><th>操作</th></tr></thead>
                <tbody id="history-tbody">${loadingRow(7)}</tbody>
            </table>
        </div>
    </div>

    <div class="modal-mask" id="detail-modal">
        <div class="modal" style="width:760px">
            <div class="modal-header">
                <h3 id="detail-title">执行结果</h3>
                <button class="modal-close" data-close>×</button>
            </div>
            <div class="modal-body" id="detail-body"></div>
            <div class="modal-footer">
                <button class="btn btn-ghost" data-close>关闭</button>
            </div>
        </div>
    </div>

    <div class="modal-mask" id="schedule-modal">
        <div class="modal" style="width:620px">
            <div class="modal-header">
                <h3 id="schedule-modal-title">新增定时任务</h3>
                <button class="modal-close" data-close>×</button>
            </div>
            <div class="modal-body">
                <div class="form-row">
                    <div class="form-item">
                        <label>任务名称</label>
                        <input class="input" id="sc-name" placeholder="每日磁盘巡检">
                    </div>
                    <div class="form-item">
                        <label>执行周期</label>
                        <select class="select" id="sc-mode" style="width:100%">
                            <option value="daily">每日定时</option>
                            <option value="interval">按间隔重复</option>
                        </select>
                    </div>
                </div>

                <div class="form-row">
                    <div class="form-item" id="sc-daily-field">
                        <label>执行时间（每日）</label>
                        <input class="input" id="sc-time" placeholder="08:30">
                    </div>
                    <div class="form-item" id="sc-interval-field" style="display:none">
                        <label>间隔（分钟）</label>
                        <input class="input" id="sc-interval" type="number" min="1" value="30">
                    </div>
                    <div class="form-item">
                        <label>执行方式</label>
                        <select class="select" id="sc-target-mode" style="width:100%">
                            <option value="cmd">执行命令</option>
                            <option value="script">执行脚本</option>
                        </select>
                    </div>
                </div>

                <div class="form-item" id="sc-cmd-field">
                    <label>执行命令</label>
                    <textarea class="textarea" id="sc-cmd" rows="2" placeholder="df -h"></textarea>
                </div>
                <div class="form-item" id="sc-script-field" style="display:none">
                    <label>选择脚本</label>
                    <select class="select" id="sc-script" style="width:100%"></select>
                </div>

                <div class="form-item">
                    <label>目标主机（已选 <span id="sc-host-count">0</span> 台）</label>
                    <div class="check-grid" id="sc-host-grid" style="max-height:180px;overflow-y:auto"></div>
                </div>

                <div class="form-row">
                    <div class="form-item">
                        <label>并发数</label>
                        <input class="input" id="sc-concurrency" type="number" min="1" max="50" value="5">
                    </div>
                    <div class="form-item">
                        <label>超时（秒）</label>
                        <input class="input" id="sc-timeout" type="number" min="5" max="600" value="30">
                    </div>
                </div>
                <div id="sc-msg" class="form-hint"></div>
            </div>
            <div class="modal-footer">
                <button class="btn btn-ghost" data-close>取消</button>
                <button class="btn btn-primary" id="schedule-save">保存</button>
            </div>
        </div>
    </div>`;
}

export async function mount(root) {
    const grid = root.querySelector('#target-grid');
    const resultEl = root.querySelector('#validate-result');
    const progressEl = root.querySelector('#progress-area');
    const tbody = root.querySelector('#history-tbody');
    const detailModal = root.querySelector('#detail-modal');

    const selectedIds = () => [...grid.querySelectorAll('input:checked')].map(i => i.dataset.host);
    const updateCount = () => {
        root.querySelector('#host-count').textContent = selectedIds().length;
        grid.querySelectorAll('.check-item').forEach(item => {
            item.classList.toggle('checked', item.querySelector('input').checked);
        });
    };

    const alertHtml = (r) => `
        <div class="alert ${r.blocked ? 'danger' : (r.whitelisted ? 'info' : 'success')}" style="margin-top:14px">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">${r.blocked
                ? '<circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/>'
                : '<polyline points="20 6 9 17 4 12"/>'}</svg>
            <span>${esc(r.reason || r.message || '')}</span>
        </div>`;

    const showResults = (taskId) => {
        api.tasks.detail(taskId).then(task => {
            if (!task) { toast('任务不存在', 'warn'); return; }
            root.querySelector('#detail-title').textContent = `执行结果 · ${task.id}`;
            const results = task.results || [];
            root.querySelector('#detail-body').innerHTML = `
                <div class="muted" style="font-size:12.5px">
                    命令：<span class="mono">${esc(task.cmd)}</span> ·
                    目标 ${esc(task.hostCount)} 台 ·
                    创建于 ${esc(task.createdAt)}
                    ${task.blockReason ? `<br><span class="text-danger">拦截原因：${esc(task.blockReason)}</span>` : ''}
                </div>
                <div class="table-wrap" style="max-height:420px;overflow-y:auto">
                    <table class="table">
                        <thead><tr><th>主机</th><th>IP</th><th>状态</th><th>退出码</th><th>耗时</th><th>输出摘要</th></tr></thead>
                        <tbody>
                        ${results.length ? results.map(r => `
                            <tr>
                                <td>${esc(r.hostName)}</td>
                                <td class="mono">${esc(r.ip)}</td>
                                <td>${r.status === 'success' ? '<span class="badge green">成功</span>' : '<span class="badge red">失败</span>'}</td>
                                <td class="mono">${esc(r.exitCode === null ? '-' : r.exitCode)}</td>
                                <td class="muted">${esc(r.durationMs)} ms</td>
                                <td class="mono" style="max-width:300px;white-space:pre-wrap;word-break:break-all">${esc((r.error || r.output || '').slice(0, 400) || '-')}</td>
                            </tr>`).join('') : emptyRow(6, '该任务无逐台结果（拦截或尚未执行）')}
                        </tbody>
                    </table>
                </div>`;
            detailModal.classList.add('open');
        });
    };

    const refreshHistory = async () => {
        try {
            history = await api.tasks.list();
            tbody.innerHTML = historyHtml();
        } catch (err) {
            tbody.innerHTML = emptyRow(7, '历史加载失败：' + err.message);
        }
    };

    // ---------- 初始化：主机 / 脚本 / 系统参数 ----------
    try {
        hosts = await api.hosts.list();
        grid.innerHTML = hosts.length ? hosts.map(h => `
            <label class="check-item">
                <input type="checkbox" data-host="${esc(h.id)}">
                <span><strong>${esc(h.name)}</strong><br><span class="mono muted">${esc(h.ip)}</span></span>
            </label>`).join('') : emptyRow(1, '暂无主机，请先到「主机管理」添加');
        root.querySelector('#host-total').textContent = hosts.length;
    } catch (err) {
        grid.innerHTML = emptyRow(1, '主机加载失败：' + err.message);
    }

    try {
        scripts = await api.scripts.list();
        root.querySelector('#script-select').innerHTML = scripts.length
            ? scripts.map(s => `<option value="${esc(s.id)}">${esc(s.name)}（${esc(s.type)}）</option>`).join('')
            : '<option value="">暂无托管脚本</option>';
    } catch (err) { /* 静默：脚本列表非必需 */ }

    try {
        const config = await api.system.getConfig();
        if (config) {
            root.querySelector('#concurrency').value = config.maxConcurrency || 10;
            root.querySelector('#timeout').value = config.cmdTimeout || 30;
        }
    } catch (err) { /* 静默：使用默认值 */ }

    updateCount();
    grid.addEventListener('change', updateCount);

    root.querySelector('#btn-select-all').addEventListener('click', () => {
        grid.querySelectorAll('input').forEach(i => { i.checked = true; });
        updateCount();
    });
    root.querySelector('#btn-select-none').addEventListener('click', () => {
        grid.querySelectorAll('input').forEach(i => { i.checked = false; });
        updateCount();
    });

    // 执行方式切换
    const modeSel = root.querySelector('#exec-mode');
    modeSel.addEventListener('change', () => {
        const isScript = modeSel.value === 'script';
        root.querySelector('#field-script').style.display = isScript ? '' : 'none';
        root.querySelector('#field-cmd').style.display = isScript ? 'none' : '';
    });

    const currentPayload = () => ({
        cmd: root.querySelector('#cmd-input').value,
        scriptId: modeSel.value === 'script' ? root.querySelector('#script-select').value : null,
        hostIds: selectedIds(),
        concurrency: parseInt(root.querySelector('#concurrency').value, 10) || 10,
        timeout: parseInt(root.querySelector('#timeout').value, 10) || 30
    });

    // ---------- 执行前校验 ----------
    root.querySelector('#btn-validate').addEventListener('click', async () => {
        const payload = currentPayload();
        if (modeSel.value === 'cmd' && !payload.cmd.trim()) { toast('请输入要执行的命令', 'warn'); return; }
        const r = await api.tasks.validate({ cmd: payload.cmd, scriptId: payload.scriptId });
        resultEl.innerHTML = alertHtml(r);
    });

    // ---------- 提交执行 ----------
    root.querySelector('#btn-execute').addEventListener('click', async () => {
        if (!guardWrite('执行批量任务')) return;
        const payload = currentPayload();
        if (!payload.hostIds.length) { toast('请先选择目标主机', 'warn'); return; }
        if (modeSel.value === 'cmd' && !payload.cmd.trim()) { toast('请输入要执行的命令', 'warn'); return; }

        const btn = root.querySelector('#btn-execute');
        btn.disabled = true;
        btn.textContent = '执行中...';
        progressEl.innerHTML = `<div class="alert info" style="margin-top:14px">正在下发执行，等待各主机回传结果...</div>`;

        const res = await api.tasks.run(payload);
        lastSelected = payload.hostIds;

        if (res && res.blocked) {
            resultEl.innerHTML = alertHtml({ blocked: true, reason: res.message });
            progressEl.innerHTML = '';
            toast('命令已被安全策略拦截', 'danger');
        } else if (res && res.ok) {
            const t = res.task;
            progressEl.innerHTML = `
                <div class="alert ${t.status === 'success' ? 'success' : 'warn'}" style="margin-top:14px">
                    <span>任务 ${esc(t.id)} 执行完成：成功 ${esc(t.successCount)} 台 · 失败 ${esc(t.failedCount)} 台</span>
                </div>`;
            toast(`任务 ${t.id} 执行完成`, t.status === 'success' ? 'success' : 'warn');
            await refreshHistory();
            showResults(t.id);
        } else {
            progressEl.innerHTML = '';
            toast((res && res.message) || '执行失败', 'danger');
        }

        btn.disabled = false;
        btn.textContent = '开始执行';
    });

    // ---------- 进度推送 ----------
    api.onTaskProgress(p => {
        if (p.phase === 'start') {
            progressEl.innerHTML = `<div class="alert info" style="margin-top:14px">任务 ${esc(p.taskId)} 开始执行，共 ${esc(p.total)} 台主机（并发受系统配置限制）</div>`;
        } else if (p.phase === 'running') {
            const pct = Math.round((p.done / p.total) * 100);
            progressEl.innerHTML = `
                <div class="card" style="padding:14px;margin-top:14px">
                    <div style="display:flex;justify-content:space-between;font-size:12.5px;margin-bottom:8px">
                        <span>执行进度 ${p.done}/${p.total}</span>
                        <span class="muted">最近：${esc(p.host || '')} · ${p.status === 'success' ? '成功' : '失败'}</span>
                    </div>
                    <div style="height:6px;background:#eef1f7;border-radius:3px;overflow:hidden">
                        <div style="height:100%;width:${pct}%;background:var(--primary);transition:width .2s"></div>
                    </div>
                </div>`;
        }
    });

    // ---------- 历史操作 ----------
    root.querySelector('#btn-reload-history').addEventListener('click', refreshHistory);

    tbody.addEventListener('click', async e => {
        const detailBtn = e.target.closest('[data-detail]');
        const exportBtn = e.target.closest('[data-export]');

        if (detailBtn) showResults(detailBtn.dataset.detail);

        if (exportBtn) {
            const res = await api.tasks.exportCsv(exportBtn.dataset.export);
            if (!res || !res.ok) { toast((res && res.message) || '导出失败', 'danger'); return; }
            const blob = new Blob(['\ufeff' + res.content], { type: 'text/csv;charset=utf-8' });
            const a = document.createElement('a');
            a.href = URL.createObjectURL(blob);
            a.download = res.filename;
            a.click();
            URL.revokeObjectURL(a.href);
            toast('结果已导出', 'success');
        }
    });

    detailModal.querySelectorAll('[data-close]').forEach(el =>
        el.addEventListener('click', () => detailModal.classList.remove('open')));

    /* ---------------- 定时任务调度 ---------------- */

    const scheduleTbody = root.querySelector('#schedule-tbody');
    const scheduleModal = root.querySelector('#schedule-modal');

    const refreshSchedules = async () => {
        try {
            schedules = await api.schedules.list();
            scheduleTbody.innerHTML = schedules.length
                ? schedules.map(scheduleRow).join('')
                : emptyRow(8, '暂无定时任务');
        } catch (err) {
            scheduleTbody.innerHTML = emptyRow(8, '定时任务加载失败：' + err.message);
        }
    };

    const paintScheduleHosts = (selected) => {
        const grid = root.querySelector('#sc-host-grid');
        grid.innerHTML = hosts.length ? hosts.map(h => `
            <label class="check-item">
                <input type="checkbox" data-host="${esc(h.id)}" ${selected.includes(h.id) ? 'checked' : ''}>
                <span>${esc(h.name)}<br><span class="mono muted">${esc(h.ip)}</span></span>
            </label>`).join('') : '<div class="empty">暂无主机</div>';
        const update = () => {
            root.querySelector('#sc-host-count').textContent = grid.querySelectorAll('input:checked').length;
            grid.querySelectorAll('.check-item').forEach(item =>
                item.classList.toggle('checked', item.querySelector('input').checked));
        };
        grid.onchange = update;
        update();
    };

    const openScheduleModal = (schedule) => {
        editingScheduleId = schedule ? schedule.id : null;
        root.querySelector('#schedule-modal-title').textContent = schedule ? `编辑 · ${schedule.name}` : '新增定时任务';
        root.querySelector('#sc-name').value = schedule ? schedule.name : '';
        root.querySelector('#sc-mode').value = schedule ? schedule.mode : 'daily';
        root.querySelector('#sc-time').value = schedule ? (schedule.time || '08:30') : '08:30';
        root.querySelector('#sc-interval').value = schedule ? (schedule.intervalMinutes || 30) : 30;
        const targetMode = schedule && schedule.scriptId ? 'script' : 'cmd';
        root.querySelector('#sc-target-mode').value = targetMode;
        root.querySelector('#sc-cmd').value = schedule ? (schedule.cmd || '') : '';
        root.querySelector('#sc-script').innerHTML = scripts.length
            ? scripts.map(s => `<option value="${esc(s.id)}" ${schedule && schedule.scriptId === s.id ? 'selected' : ''}>${esc(s.name)}（${esc(s.type)}）</option>`).join('')
            : '<option value="">暂无托管脚本</option>';
        root.querySelector('#sc-concurrency').value = schedule ? (schedule.concurrency || 5) : 5;
        root.querySelector('#sc-timeout').value = schedule ? (schedule.timeout || 30) : 30;
        root.querySelector('#sc-msg').textContent = '';
        toggleScheduleFields();
        paintScheduleHosts(schedule ? (schedule.hostIds || []) : []);
        scheduleModal.classList.add('open');
    };

    const toggleScheduleFields = () => {
        const isDaily = root.querySelector('#sc-mode').value === 'daily';
        root.querySelector('#sc-daily-field').style.display = isDaily ? '' : 'none';
        root.querySelector('#sc-interval-field').style.display = isDaily ? 'none' : '';
        const isScript = root.querySelector('#sc-target-mode').value === 'script';
        root.querySelector('#sc-script-field').style.display = isScript ? '' : 'none';
        root.querySelector('#sc-cmd-field').style.display = isScript ? 'none' : '';
    };

    root.querySelector('#btn-add-schedule').addEventListener('click', () => {
        if (!guardAdmin('新增定时任务')) return;
        openScheduleModal(null);
    });
    root.querySelector('#btn-reload-schedules').addEventListener('click', refreshSchedules);
    scheduleModal.querySelectorAll('[data-close]').forEach(el =>
        el.addEventListener('click', () => scheduleModal.classList.remove('open')));
    root.querySelector('#sc-mode').addEventListener('change', toggleScheduleFields);
    root.querySelector('#sc-target-mode').addEventListener('change', toggleScheduleFields);

    root.querySelector('#schedule-save').addEventListener('click', async () => {
        if (!guardAdmin('保存定时任务')) return;
        const mode = root.querySelector('#sc-mode').value;
        const targetMode = root.querySelector('#sc-target-mode').value;
        const hostIds = [...root.querySelectorAll('#sc-host-grid input:checked')].map(i => i.dataset.host);
        const payload = {
            id: editingScheduleId || undefined,
            name: root.querySelector('#sc-name').value.trim(),
            mode,
            time: root.querySelector('#sc-time').value.trim(),
            intervalMinutes: parseInt(root.querySelector('#sc-interval').value, 10),
            cmd: targetMode === 'cmd' ? root.querySelector('#sc-cmd').value : '',
            scriptId: targetMode === 'script' ? root.querySelector('#sc-script').value : null,
            hostIds,
            concurrency: parseInt(root.querySelector('#sc-concurrency').value, 10) || 5,
            timeout: parseInt(root.querySelector('#sc-timeout').value, 10) || 30,
            enabled: editingScheduleId ? (schedules.find(s => s.id === editingScheduleId) || {}).enabled !== false : true
        };
        if (!payload.name) { root.querySelector('#sc-msg').innerHTML = '<span class="text-danger">请填写任务名称</span>'; return; }

        const res = await api.schedules.save(payload);
        if (res && res.ok) {
            toast(`定时任务已保存：${res.schedule.scheduleText}`, 'success');
            scheduleModal.classList.remove('open');
            await refreshSchedules();
        } else {
            root.querySelector('#sc-msg').innerHTML = `<span class="text-danger">${esc((res && res.message) || '保存失败')}</span>`;
        }
    });

    scheduleTbody.addEventListener('change', async e => {
        const input = e.target.closest('[data-toggle]');
        if (!input) return;
        if (!guardAdmin('启停定时任务')) { input.checked = !input.checked; return; }
        const res = await api.schedules.toggle(input.dataset.toggle, input.checked);
        if (res && res.ok) {
            toast(`已${input.checked ? '启用' : '停用'}，下次执行：${res.schedule.nextRunText}`, 'success');
            await refreshSchedules();
        } else {
            input.checked = !input.checked;
            toast((res && res.message) || '操作失败', 'danger');
        }
    });

    scheduleTbody.addEventListener('click', async e => {
        const btn = e.target.closest('[data-act]');
        if (!btn) return;
        const id = btn.closest('tr').dataset.id;
        const schedule = schedules.find(s => s.id === id);

        if (btn.dataset.act === 'edit') {
            if (!guardAdmin('编辑定时任务')) return;
            openScheduleModal(schedule);
        } else if (btn.dataset.act === 'delete') {
            if (!guardAdmin('删除定时任务')) return;
            if (!confirm(`确认删除定时任务「${schedule.name}」？`)) return;
            const res = await api.schedules.remove(id);
            if (res && res.ok) { toast('已删除', 'success'); await refreshSchedules(); }
            else toast('删除失败', 'danger');
        } else if (btn.dataset.act === 'run') {
            if (!guardWrite('立即执行')) return;
            btn.textContent = '执行中...';
            btn.disabled = true;
            const res = await api.schedules.runNow(id);
            btn.textContent = '立即执行';
            btn.disabled = false;
            toast(res && res.ok ? `已触发：${res.status}` : ((res && res.message) || '触发失败'),
                res && res.ok && res.status !== 'failed' ? 'success' : 'warn');
            await refreshSchedules();
            await refreshHistory();
        }
    });

    // 调度器执行进度（仅提示，刷新列表由 30s 轮询兜底）
    api.onScheduleProgress(p => {
        if (p.phase === 'start') toast(`定时任务「${p.name}」开始执行（${p.trigger === 'manual' ? '手动' : '定时'}）`, 'info');
        if (p.phase === 'done') refreshSchedules();
    });

    // 只读角色：统一禁用写操作按钮
    applyReadonly(root);

    await refreshHistory();
    await refreshSchedules();
}
