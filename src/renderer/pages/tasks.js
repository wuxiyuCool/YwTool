/**
 * 任务执行页（终端工作台，Xshell 风格）
 * ------------------------------------------------------------------
 * 顶部标签：终端工作台 / 批量执行 / 定时任务 / 执行历史
 *   - 终端工作台：左侧主机列表 → 打开交互式 SSH 会话（多标签）。终端由内置的 xterm.js
 *     （本地 vendor，零运行期依赖）渲染：Tab 补全、光标行内编辑、完整 ANSI 彩色/高亮；
 *     底部输入框改为「批量命令」，可勾选多个已连接会话同时下发同一命令。
 *     数据流 terminal:open/input/resize + terminal:data/exit 推送
 *   - 批量执行：命令/脚本先经敏感词校验，主进程并发 SSH，实时进度推送
 *   - 定时任务：schedules:list|save|toggle|delete|runNow（调度器 30s 心跳）
 *   - 执行历史：tasks:list / tasks:detail / tasks:export
 */
import { Terminal } from '../vendor/xterm/xterm.mjs';
import { FitAddon } from '../vendor/xterm/addon-fit.mjs';
import { api, demoMode } from '../api.js';
import { esc, toast, demoBanner, emptyRow, loadingRow, shortTime, guardWrite, guardAdmin, applyReadonly, promptText } from '../ui.js';

let hosts = [];
let scripts = [];
let history = [];
let schedules = [];
let lastSelected = [];
let editingScheduleId = null;

/* ---------------- 终端会话状态 ---------------- */
/** sessionId → { hostName, hostId, term, fit, paneEl, closed } */
const termSessions = new Map();
let activeSession = null;
let termUnsubs = [];
/** document 级收起监听（重复 mount 时先摘旧的） */
let docCloseHandler = null;
let quickCmds = loadQuickCmds();

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

/* ---------------- xterm 终端 ---------------- */

const TERM_FONT = '"Cascadia Mono", "JetBrains Mono", Consolas, "Courier New", monospace';
const TERM_THEME = {
    background: '#1e2430',
    foreground: '#d5dbe6',
    cursor: '#7ab8ff',
    cursorAccent: '#1e2430',
    selectionBackground: '#33415c',
    black: '#2b3240', red: '#e05555', green: '#57c26b', yellow: '#e0b45a',
    blue: '#5a9de0', magenta: '#c25ad1', cyan: '#4ec9c9', white: '#d5dbe6',
    brightBlack: '#7a7a8a', brightRed: '#ff6b6b', brightGreen: '#6ee787', brightYellow: '#ffd97a',
    brightBlue: '#7ab8ff', brightMagenta: '#e57bff', brightCyan: '#6fe7e7', brightWhite: '#ffffff'
};

/** 新建 xterm 实例：Tab 补全、行内编辑、完整 ANSI 彩色的语义都由远端 shell 通过 PTY 回传，xterm 如实渲染 */
function makeTerminal() {
    const term = new Terminal({
        fontFamily: TERM_FONT,
        fontSize: 13,
        lineHeight: 1.2,
        cursorBlink: true,
        scrollback: 6000,
        theme: TERM_THEME
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    return { term, fit };
}

/* ---------------- 快捷命令（localStorage 持久化） ---------------- */

function loadQuickCmds() {
    try { return JSON.parse(localStorage.getItem('sgops.quickCmds') || '[]'); } catch (e) { return []; }
}
function saveQuickCmds() {
    try { localStorage.setItem('sgops.quickCmds', JSON.stringify(quickCmds)); } catch (e) { /* ignore */ }
}

/* ---------------- 终端 HTML 片段 ---------------- */

function sessionTabHtml(id, name, active) {
    return `<div class="wt-session-tab ${active ? 'active' : ''}" data-sid="${esc(id)}">
        <span class="wt-session-dot"></span>${esc(name)}
        <button class="wt-session-close" data-close-sid="${esc(id)}" title="关闭会话">×</button>
    </div>`;
}

function quickCmdHtml() {
    if (!quickCmds.length) return '<span class="muted" style="font-size:12px">暂无快捷命令，点右侧「+ 添加」保存常用命令</span>';
    return quickCmds.map((c, idx) =>
        `<span class="wt-quick-chip" data-quick="${idx}" title="${esc(c.cmd)}">${esc(c.label || c.cmd)}<i class="wt-quick-del" data-del-quick="${idx}">×</i></span>`).join('');
}

/* ---------------- 批量/定时/历史（沿用原逻辑） ---------------- */

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
        <td><label class="switch"><input type="checkbox" data-toggle="${esc(s.id)}" ${s.enabled ? 'checked' : ''} data-write><span class="track"></span></label></td>
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
    <div class="wt-tabs" id="wt-tabs">
        <div class="wt-tab active" data-wt="term">终端工作台</div>
        <div class="wt-tab" data-wt="batch">批量执行</div>
        <div class="wt-tab" data-wt="sched">定时任务</div>
        <div class="wt-tab" data-wt="hist">执行历史</div>
    </div>

    <!-- 终端工作台 -->
    <div class="wt-panel" data-panel="term">
        <div class="wt-layout">
            <aside class="wt-hosts">
                <div class="wt-hosts-head">
                    <span>主机</span>
                    <button class="btn-link" id="wt-reload-hosts">刷新</button>
                </div>
                <div class="wt-hosts-list" id="wt-host-list">${loadingRow(1, '加载中...')}</div>
            </aside>
            <section class="wt-term">
                <div class="wt-session-tabs" id="wt-session-tabs">
                    <span class="muted wt-empty-hint" id="wt-empty-hint">从左侧选择主机并「连接」以打开终端会话</span>
                </div>
                <div class="wt-term-body" id="wt-term-body">
                    <div class="wt-term-placeholder" id="wt-term-placeholder">
                        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><rect x="2" y="4" width="20" height="16" rx="2"/><path d="M6 9l3 3-3 3M12 15h6"/></svg>
                        <div>未打开会话</div>
                        <span class="muted" style="font-size:12px">支持多会话并行；Tab 补全、彩色高亮，底部可多选会话批量下发命令</span>
                    </div>
                    <!-- 脚本选择浮层 -->
                    <div class="wt-script-pop" id="wt-script-pop" style="display:none">
                        <div class="wt-script-pop-head">
                            <span>执行托管脚本</span>
                            <input class="input" id="wt-script-search" placeholder="搜索脚本名 / 说明" style="height:26px;font-size:12px">
                        </div>
                        <div class="wt-script-list" id="wt-script-list"></div>
                    </div>
                </div>
                <div class="wt-quick-bar">
                    <div class="wt-quick-chips" id="wt-quick-chips">${quickCmdHtml()}</div>
                    <button class="btn btn-ghost btn-sm" id="wt-script-btn" title="从脚本库选择并发送到当前会话">脚本库</button>
                    <button class="btn btn-ghost btn-sm" id="wt-quick-add">+ 添加</button>
                </div>
                <div class="wt-batch-row">
                    <div class="wt-batch-head">
                        <span class="wt-batch-label">批量命令</span>
                        <div class="wt-targets" id="wt-batch-targets"><span class="muted" style="font-size:12px">暂无已连接会话</span></div>
                        <button class="btn-link" id="wt-batch-all">全选</button>
                        <button class="btn-link" id="wt-batch-none">清空</button>
                    </div>
                    <div class="wt-input-row">
                        <span class="wt-prompt">$</span>
                        <textarea class="input mono wt-input" id="wt-input" rows="1" placeholder="输入命令后回车，下发到勾选的会话（Shift+回车换行；Tab 补全请在终端窗口内使用）" autocomplete="off" spellcheck="false"></textarea>
                        <button class="btn btn-primary btn-sm" id="wt-send" data-write>发送</button>
                    </div>
                </div>
            </section>
        </div>
    </div>

    <!-- 批量执行 -->
    <div class="wt-panel" data-panel="batch" style="display:none">
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
                    <div class="wt-script-preview mono" id="script-preview" style="display:none"></div>
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
    </div>

    <!-- 定时任务 -->
    <div class="wt-panel" data-panel="sched" style="display:none">
        <div class="card">
            <div class="card-header">
                <div>
                    <div class="card-title">定时任务</div>
                    <div class="card-desc">按周期自动重复执行，与手动执行走完全一致的安全校验与审计链路</div>
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
    </div>

    <!-- 执行历史 -->
    <div class="wt-panel" data-panel="hist" style="display:none">
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
    </div>

    <div class="modal-mask" id="detail-modal">
        <div class="modal" style="width:760px">
            <div class="modal-header"><h3 id="detail-title">执行结果</h3><button class="modal-close" data-close>×</button></div>
            <div class="modal-body" id="detail-body"></div>
            <div class="modal-footer"><button class="btn btn-ghost" data-close>关闭</button></div>
        </div>
    </div>

    <div class="modal-mask" id="schedule-modal">
        <div class="modal" style="width:620px">
            <div class="modal-header"><h3 id="schedule-modal-title">新增定时任务</h3><button class="modal-close" data-close>×</button></div>
            <div class="modal-body">
                <div class="form-row">
                    <div class="form-item"><label>任务名称</label><input class="input" id="sc-name" placeholder="每日磁盘巡检"></div>
                    <div class="form-item"><label>执行周期</label><select class="select" id="sc-mode" style="width:100%"><option value="daily">每日定时</option><option value="interval">按间隔重复</option></select></div>
                </div>
                <div class="form-row">
                    <div class="form-item" id="sc-daily-field"><label>执行时间（每日）</label><input class="input" id="sc-time" placeholder="08:30"></div>
                    <div class="form-item" id="sc-interval-field" style="display:none"><label>间隔（分钟）</label><input class="input" id="sc-interval" type="number" min="1" value="30"></div>
                    <div class="form-item"><label>执行方式</label><select class="select" id="sc-target-mode" style="width:100%"><option value="cmd">执行命令</option><option value="script">执行脚本</option></select></div>
                </div>
                <div class="form-item" id="sc-cmd-field"><label>执行命令</label><textarea class="textarea" id="sc-cmd" rows="2" placeholder="df -h"></textarea></div>
                <div class="form-item" id="sc-script-field" style="display:none"><label>选择脚本</label><select class="select" id="sc-script" style="width:100%"></select></div>
                <div class="form-item"><label>目标主机（已选 <span id="sc-host-count">0</span> 台）</label><div class="check-grid" id="sc-host-grid" style="max-height:180px;overflow-y:auto"></div></div>
                <div class="form-row">
                    <div class="form-item"><label>并发数</label><input class="input" id="sc-concurrency" type="number" min="1" max="50" value="5"></div>
                    <div class="form-item"><label>超时（秒）</label><input class="input" id="sc-timeout" type="number" min="5" max="600" value="30"></div>
                </div>
                <div id="sc-msg" class="form-hint"></div>
            </div>
            <div class="modal-footer"><button class="btn btn-ghost" data-close>取消</button><button class="btn btn-primary" id="schedule-save">保存</button></div>
        </div>
    </div>`;
}

export async function mount(root) {
    // router 复用不回调 unmount：每次挂载先清理上一轮的推送订阅与会话，避免监听器泄漏
    termUnsubs.forEach(off => { try { off && off(); } catch (e) { /* ignore */ } });
    termUnsubs = [];
    if (docCloseHandler) document.removeEventListener('click', docCloseHandler);
    termSessions.forEach(s => { try { s.term.dispose(); } catch (e) { /* ignore */ } });
    termSessions.clear();
    activeSession = null;

    const grid = root.querySelector('#target-grid');
    const resultEl = root.querySelector('#validate-result');
    const progressEl = root.querySelector('#progress-area');
    const tbody = root.querySelector('#history-tbody');
    const detailModal = root.querySelector('#detail-modal');

    /* ---------------- 标签切换 ---------------- */
    root.querySelector('#wt-tabs').addEventListener('click', e => {
        const tab = e.target.closest('.wt-tab');
        if (!tab) return;
        const id = tab.dataset.wt;
        root.querySelectorAll('#wt-tabs .wt-tab').forEach(t => t.classList.toggle('active', t === tab));
        root.querySelectorAll('.wt-panel').forEach(p => { p.style.display = p.dataset.panel === id ? '' : 'none'; });
        if (id === 'hist') refreshHistory();
        if (id === 'sched') refreshSchedules();
        if (id === 'term') requestAnimationFrame(fitActive);
    });

    /* ---------------- 终端工作台 ---------------- */
    const hostListEl = root.querySelector('#wt-host-list');
    const sessionTabsEl = root.querySelector('#wt-session-tabs');
    const termBodyEl = root.querySelector('#wt-term-body');
    const inputEl = root.querySelector('#wt-input');

    const paintHostList = () => {
        hostListEl.innerHTML = hosts.length ? hosts.map(h => `
            <div class="wt-host" data-hid="${esc(h.id)}">
                <div class="wt-host-main">
                    <div class="wt-host-name">${esc(h.name)}</div>
                    <div class="wt-host-ip mono">${esc(h.ip)}:${esc(h.port || 22)}</div>
                </div>
                <button class="btn btn-ghost btn-sm" data-connect="${esc(h.id)}" data-write>连接</button>
            </div>`).join('') : '<div class="empty">暂无主机</div>';
    };

    const paintSessionTabs = () => {
        const tabs = [...termSessions.entries()].map(([id, s]) => sessionTabHtml(id, s.hostName, id === activeSession));
        sessionTabsEl.innerHTML = tabs.length ? tabs.join('')
            : '<span class="muted wt-empty-hint" id="wt-empty-hint">从左侧选择主机并「连接」以打开终端会话</span>';
    };

    const targetEl = root.querySelector('#wt-batch-targets');
    const sendBtn = root.querySelector('#wt-send');
    /** 批量下发目标：已连接会话 ID 集合（新会话默认勾选） */
    const batchTargets = new Set();

    const fitActive = () => {
        const s = termSessions.get(activeSession);
        if (s && !s.closed) { try { s.fit.fit(); } catch (e) { /* 容器不可见时忽略 */ } }
    };

    const paintBatchTargets = () => {
        const chips = [...termSessions.entries()].map(([id, s]) =>
            `<span class="wt-target ${batchTargets.has(id) ? 'on' : ''}" data-target="${esc(id)}" title="${esc(s.hostName)}">${esc(s.hostName)}</span>`);
        targetEl.innerHTML = chips.length ? chips.join('') : '<span class="muted" style="font-size:12px">暂无已连接会话</span>';
        const n = [...batchTargets].filter(id => termSessions.has(id)).length;
        sendBtn.textContent = n ? `发送到 ${n} 个会话` : '发送';
    };

    /** 用户是否正在别的输入框（批量框/搜索框等）里打字——此时不要把焦点抢到终端 */
    const isTypingElsewhere = () => {
        const a = document.activeElement;
        return !!(a && (/(INPUT|TEXTAREA|SELECT)/.test(a.tagName) || a.isContentEditable));
    };

    const showSession = (id, { focusTerm = true } = {}) => {
        activeSession = id;
        termSessions.forEach((s, sid) => { if (s.paneEl) s.paneEl.style.display = sid === id ? 'block' : 'none'; });
        const ph = termBodyEl.querySelector('#wt-term-placeholder');
        if (ph) ph.style.display = termSessions.size ? 'none' : '';
        paintSessionTabs();
        paintBatchTargets();
        const s = termSessions.get(id);
        // 建连完成是异步的：若用户正在批量输入框打字，抢焦点会表现为“输不进去”
        if (s && focusTerm) requestAnimationFrame(() => { fitActive(); if (!isTypingElsewhere()) s.term.focus(); });
    };

    const writeSession = (id, text) => {
        const s = termSessions.get(id);
        if (s && !s.disposed) { try { s.term.write(text); } catch (e) { /* ignore */ } }
    };

    const openSession = async (hostId) => {
        if (!guardWrite('打开终端会话')) return;
        const host = hosts.find(h => h.id === hostId);
        if (!host) return;
        const opened = [...termSessions.entries()].find(([, s]) => s.hostId === hostId);
        if (opened) { showSession(opened[0]); return; }
        const btn = hostListEl.querySelector(`[data-connect="${hostId}"]`);
        if (btn) { btn.disabled = true; btn.textContent = '连接中'; }
        let res;
        try {
            res = await api.terminal.open({ hostId, cols: 100, rows: 30 });
        } catch (err) {
            toast(err.message || '连接失败', 'danger');
            return;
        } finally {
            if (btn) { btn.disabled = false; btn.textContent = '连接'; }
        }
        if (!res || !res.ok) { toast((res && res.message) || '连接失败', 'danger'); return; }

        const { term, fit } = makeTerminal();
        const paneEl = document.createElement('div');
        paneEl.className = 'wt-term-pane';
        termBodyEl.insertBefore(paneEl, termBodyEl.querySelector('#wt-script-pop'));
        term.open(paneEl);
        const sess = { hostName: res.hostName, hostId, term, fit, paneEl, closed: false, disposed: false };
        termSessions.set(res.sessionId, sess);
        batchTargets.add(res.sessionId);   // 新会话默认加入批量下发
        // 每一次键入（含 Tab 补全、方向键、Ctrl 组合）原样写入 PTY，交互与本地终端一致
        term.onData(data => { if (!sess.closed) api.terminal.input(res.sessionId, data); });
        term.onResize(({ cols, rows }) => { if (!sess.closed) api.terminal.resize(res.sessionId, cols, rows); });
        showSession(res.sessionId);
        fitActive();
        writeSession(res.sessionId, `\x1b[36m已连接 ${res.hostName}\x1b[0m\r\n`);
    };

    const closeSession = async (id) => {
        const s = termSessions.get(id);
        if (s) {
            s.closed = true;
            s.disposed = true;
            try { s.term.dispose(); } catch (e) { /* ignore */ }
            if (s.paneEl) s.paneEl.remove();
        }
        await api.terminal.close(id);
        termSessions.delete(id);
        batchTargets.delete(id);
        if (activeSession === id) {
            activeSession = termSessions.keys().next().value || null;
            if (activeSession) showSession(activeSession);
            else {
                const ph = termBodyEl.querySelector('#wt-term-placeholder');
                if (ph) ph.style.display = '';
                paintSessionTabs();
                paintBatchTargets();
            }
        } else {
            paintSessionTabs();
            paintBatchTargets();
        }
    };

    const sendInput = async (text) => {
        if (!activeSession || !termSessions.has(activeSession)) { toast('请先从左侧连接一台主机', 'warn'); return; }
        if (!guardWrite('终端交互')) return;
        await api.terminal.input(activeSession, text);
    };

    hostListEl.addEventListener('click', e => {
        const c = e.target.closest('[data-connect]');
        if (c) { openSession(c.dataset.connect); return; }
        const h = e.target.closest('[data-hid]');
        if (h) {
            const sid = [...termSessions.entries()].find(([, s]) => s.hostId === h.dataset.hid);
            if (sid) showSession(sid[0]);
        }
    });
    root.querySelector('#wt-reload-hosts').addEventListener('click', async () => {
        try { hosts = await api.hosts.list(); paintHostList(); paintBatchGrid(); } catch (err) { toast('主机刷新失败', 'danger'); }
    });
    sessionTabsEl.addEventListener('click', e => {
        const close = e.target.closest('[data-close-sid]');
        if (close) { e.stopPropagation(); closeSession(close.dataset.closeSid); return; }
        const tab = e.target.closest('[data-sid]');
        if (tab) showSession(tab.dataset.sid);
    });
    targetEl.addEventListener('click', e => {
        const chip = e.target.closest('[data-target]');
        if (!chip) return;
        const id = chip.dataset.target;
        if (batchTargets.has(id)) batchTargets.delete(id); else batchTargets.add(id);
        paintBatchTargets();
        inputEl.focus();   // 勾选目标后把焦点还给批量输入框，避免“点完芯片再敲字没反应”
    });
    root.querySelector('#wt-batch-all').addEventListener('click', () => {
        termSessions.forEach((_, id) => batchTargets.add(id));
        paintBatchTargets();
        inputEl.focus();
    });
    root.querySelector('#wt-batch-none').addEventListener('click', () => {
        batchTargets.clear();
        paintBatchTargets();
        inputEl.focus();
    });

    const autoGrow = () => {
        inputEl.style.height = 'auto';
        inputEl.style.height = Math.min(inputEl.scrollHeight, 120) + 'px';
    };
    // 批量下发：命令同时写入所有勾选会话（各自终端独立回显）
    const doSend = async () => {
        const ids = [...batchTargets].filter(id => termSessions.has(id));
        if (!ids.length) { toast('请先连接主机，并勾选至少一个下发目标', 'warn'); return; }
        if (!guardWrite('终端交互')) return;
        const v = inputEl.value;
        const payload = v === '' ? '\n' : (v.endsWith('\n') ? v : v + '\n');
        inputEl.value = '';
        autoGrow();
        await Promise.all(ids.map(id => api.terminal.input(id, payload)));
        inputEl.focus();   // 连续下发时无需再点一次输入框
    };
    root.querySelector('#wt-send').addEventListener('click', doSend);
    inputEl.addEventListener('input', autoGrow);
    inputEl.addEventListener('keydown', e => {
        if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); doSend(); }
    });

    // 点在终端区（含面板内边距）时确保键盘焦点交给 xterm
    termBodyEl.addEventListener('mousedown', e => {
        if (e.target.closest('.wt-script-pop')) return;
        const s = termSessions.get(activeSession);
        if (!s || s.closed) return;
        if (!e.target.closest('.xterm')) { e.preventDefault(); s.term.focus(); }
    });

    // 容器尺寸变化（窗口缩放/侧栏收起）时重新适配列宽行高
    const ro = new ResizeObserver(() => { if (activeSession) requestAnimationFrame(fitActive); });
    ro.observe(termBodyEl);
    termUnsubs.push(() => ro.disconnect());

    /* ---------------- 脚本库浮层 ---------------- */
    const scriptPopEl = root.querySelector('#wt-script-pop');
    const scriptListEl = root.querySelector('#wt-script-list');
    const scriptSearchEl = root.querySelector('#wt-script-search');
    const TYPE_BADGE = { shell: 'blue', python: 'purple', compose: 'gray' };

    const paintScriptPop = () => {
        const kw = scriptSearchEl.value.trim().toLowerCase();
        const list = scripts.filter(s => !kw || `${s.name} ${s.desc || ''}`.toLowerCase().includes(kw));
        scriptListEl.innerHTML = list.length ? list.map(s => `
            <div class="wt-script-item" data-sid="${esc(s.id)}">
                <div class="wt-script-main">
                    <div class="wt-script-name">${esc(s.name)} <span class="badge ${TYPE_BADGE[s.type] || 'gray'}" style="font-size:10px;padding:0 5px">${esc(s.type)}</span>
                        ${s.version ? `<span class="muted" style="font-size:11px">${esc(s.version)}</span>` : ''}</div>
                    <div class="wt-script-desc muted">${esc(s.desc || '')}</div>
                </div>
                <div class="wt-script-ops">
                    <button class="btn-link" data-sact="run" data-write title="发送到当前终端会话执行">▶ 执行</button>
                    <button class="btn-link" data-sact="fill" title="填入输入行编辑后发送">填入</button>
                </div>
            </div>`).join('') : '<div class="empty" style="padding:16px">无匹配脚本</div>';
    };
    const toggleScriptPop = (show) => {
        scriptPopEl.style.display = show ? '' : 'none';
        if (show) { paintScriptPop(); scriptSearchEl.focus(); }
    };
    root.querySelector('#wt-script-btn').addEventListener('click', e => {
        e.stopPropagation();
        toggleScriptPop(scriptPopEl.style.display === 'none');
    });
    scriptSearchEl.addEventListener('input', paintScriptPop);
    scriptSearchEl.addEventListener('click', e => e.stopPropagation());
    scriptListEl.addEventListener('click', async e => {
        e.stopPropagation();
        const btn = e.target.closest('[data-sact]');
        const item = e.target.closest('[data-sid]');
        if (!btn || !item) return;
        const script = scripts.find(s => s.id === item.dataset.sid);
        if (!script) return;
        if (btn.dataset.sact === 'fill') {
            inputEl.value = script.content || '';
            autoGrow();
            inputEl.focus();
            toggleScriptPop(false);
            return;
        }
        // ▶ 执行：发送到当前活跃会话（主进程包装 heredoc，交互模式不退出 shell）
        if (!activeSession || !termSessions.has(activeSession)) { toast('请先从左侧连接一台主机', 'warn'); return; }
        if (!guardWrite('终端执行脚本')) return;
        const res = await api.terminal.runScript(activeSession, script.id);
        if (res && res.ok) {
            toast(`脚本「${res.name}」已发送到 ${termSessions.get(activeSession).hostName}`, 'success');
            toggleScriptPop(false);
        } else toast((res && res.message) || '发送失败', 'danger');
    });
    // 点击其它区域收起浮层（模块级引用，mount 时先摘旧的防重复注册）
    docCloseHandler = e => {
        if (scriptPopEl.style.display !== 'none' && !scriptPopEl.contains(e.target) && e.target.id !== 'wt-script-btn') {
            toggleScriptPop(false);
        }
    };
    document.addEventListener('click', docCloseHandler);

    // 快捷命令：点击发送，右键删除，「+ 添加」保存当前输入
    root.querySelector('#wt-quick-chips').addEventListener('click', e => {
        const del = e.target.closest('[data-del-quick]');
        if (del) { quickCmds.splice(Number(del.dataset.delQuick), 1); saveQuickCmds(); refreshQuick(); return; }
        const chip = e.target.closest('[data-quick]');
        if (chip) {
            const c = quickCmds[Number(chip.dataset.quick)];
            if (!c) return;
            if (activeSession && termSessions.has(activeSession)) sendInput(c.cmd + '\n');
            else { inputEl.value = c.cmd; autoGrow(); inputEl.focus(); }
        }
    });
    root.querySelector('#wt-quick-add').addEventListener('click', async () => {
        let cmd = (inputEl.value || '').trim();
        if (!cmd) cmd = (await promptText('输入要保存为快捷命令的内容：')) || '';
        if (!cmd) return;
        const label = (await promptText('命令别名（显示在按钮上）：', cmd.slice(0, 12))) || cmd.slice(0, 12);
        quickCmds.push({ label, cmd });
        saveQuickCmds();
        refreshQuick();
        toast('已加入快捷命令栏', 'success');
    });
    function refreshQuick() { root.querySelector('#wt-quick-chips').innerHTML = quickCmdHtml(); }

    // 订阅推送（会话数据 / 退出）
    termUnsubs.push(api.terminal.onData(({ sessionId, chunk }) => writeSession(sessionId, chunk)));
    termUnsubs.push(api.terminal.onExit(({ sessionId, message }) => {
        if (termSessions.has(sessionId)) {
            writeSession(sessionId, `\r\n\x1b[33m${message || '会话已结束'}\x1b[0m\r\n`);
            const s = termSessions.get(sessionId);
            if (s) s.closed = true;
            batchTargets.delete(sessionId);   // 已断开的会话不再作为批量下发目标
            paintBatchTargets();
        }
    }));

    try { hosts = await api.hosts.list(); } catch (err) { hosts = []; }
    paintHostList();

    /* ---------------- 批量执行（沿用原逻辑） ---------------- */
    const selectedIds = () => [...grid.querySelectorAll('input:checked')].map(i => i.dataset.host);
    const updateCount = () => {
        root.querySelector('#host-count').textContent = selectedIds().length;
        grid.querySelectorAll('.check-item').forEach(item => item.classList.toggle('checked', item.querySelector('input').checked));
    };
    const paintBatchGrid = () => {
        grid.innerHTML = hosts.length ? hosts.map(h => `
            <label class="check-item">
                <input type="checkbox" data-host="${esc(h.id)}">
                <span><strong>${esc(h.name)}</strong><br><span class="mono muted">${esc(h.ip)}</span></span>
            </label>`).join('') : emptyRow(1, '暂无主机，请先到「主机管理」添加');
        root.querySelector('#host-total').textContent = hosts.length;
        updateCount();
    };
    paintBatchGrid();

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
                    命令：<span class="mono">${esc(task.cmd)}</span> · 目标 ${esc(task.hostCount)} 台 · 创建于 ${esc(task.createdAt)}
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
        try { history = await api.tasks.list(); tbody.innerHTML = historyHtml(); }
        catch (err) { tbody.innerHTML = emptyRow(7, '历史加载失败：' + err.message); }
    };

    try {
        scripts = await api.scripts.list();
        root.querySelector('#script-select').innerHTML = scripts.length
            ? scripts.map(s => `<option value="${esc(s.id)}">${esc(s.name)}（${esc(s.type)}）</option>`).join('')
            : '<option value="">暂无托管脚本</option>';
    } catch (err) { /* 静默 */ }

    try {
        const config = await api.system.getConfig();
        if (config) {
            root.querySelector('#concurrency').value = config.maxConcurrency || 10;
            root.querySelector('#timeout').value = config.cmdTimeout || 30;
        }
    } catch (err) { /* 静默 */ }

    grid.addEventListener('change', updateCount);
    root.querySelector('#btn-select-all').addEventListener('click', () => { grid.querySelectorAll('input').forEach(i => { i.checked = true; }); updateCount(); });
    root.querySelector('#btn-select-none').addEventListener('click', () => { grid.querySelectorAll('input').forEach(i => { i.checked = false; }); updateCount(); });

    const modeSel = root.querySelector('#exec-mode');
    modeSel.addEventListener('change', () => {
        const isScript = modeSel.value === 'script';
        root.querySelector('#field-script').style.display = isScript ? '' : 'none';
        root.querySelector('#field-cmd').style.display = isScript ? 'none' : '';
        paintScriptPreview();
    });

    // 选择脚本 → 内容预览，批量执行前所见即所得
    const paintScriptPreview = () => {
        const box = root.querySelector('#script-preview');
        const script = scripts.find(s => s.id === root.querySelector('#script-select').value);
        if (!script || modeSel.value !== 'script') { box.style.display = 'none'; return; }
        box.style.display = '';
        box.innerHTML = `<div class="wt-script-preview-head">${esc(script.name)} · ${esc(script.type)} ${esc(script.version || '')} · ${esc(script.desc || '')}</div><pre>${esc(script.content || '')}</pre>`;
    };
    root.querySelector('#script-select').addEventListener('change', paintScriptPreview);

    const currentPayload = () => ({
        cmd: root.querySelector('#cmd-input').value,
        scriptId: modeSel.value === 'script' ? root.querySelector('#script-select').value : null,
        hostIds: selectedIds(),
        concurrency: parseInt(root.querySelector('#concurrency').value, 10) || 10,
        timeout: parseInt(root.querySelector('#timeout').value, 10) || 30
    });

    root.querySelector('#btn-validate').addEventListener('click', async () => {
        const payload = currentPayload();
        if (modeSel.value === 'cmd' && !payload.cmd.trim()) { toast('请输入要执行的命令', 'warn'); return; }
        const r = await api.tasks.validate({ cmd: payload.cmd, scriptId: payload.scriptId });
        resultEl.innerHTML = alertHtml(r);
    });

    root.querySelector('#btn-execute').addEventListener('click', async () => {
        if (!guardWrite('执行批量任务')) return;
        const payload = currentPayload();
        if (!payload.hostIds.length) { toast('请先选择目标主机', 'warn'); return; }
        if (modeSel.value === 'cmd' && !payload.cmd.trim()) { toast('请输入要执行的命令', 'warn'); return; }
        const btn = root.querySelector('#btn-execute');
        btn.disabled = true; btn.textContent = '执行中...';
        progressEl.innerHTML = `<div class="alert info" style="margin-top:14px">正在下发执行，等待各主机回传结果...</div>`;
        const res = await api.tasks.run(payload);
        lastSelected = payload.hostIds;
        if (res && res.blocked) {
            resultEl.innerHTML = alertHtml({ blocked: true, reason: res.message });
            progressEl.innerHTML = '';
            toast('命令已被安全策略拦截', 'danger');
        } else if (res && res.ok) {
            const t = res.task;
            progressEl.innerHTML = `<div class="alert ${t.status === 'success' ? 'success' : 'warn'}" style="margin-top:14px"><span>任务 ${esc(t.id)} 执行完成：成功 ${esc(t.successCount)} 台 · 失败 ${esc(t.failedCount)} 台</span></div>`;
            toast(`任务 ${t.id} 执行完成`, t.status === 'success' ? 'success' : 'warn');
            await refreshHistory();
            showResults(t.id);
        } else {
            progressEl.innerHTML = '';
            toast((res && res.message) || '执行失败', 'danger');
        }
        btn.disabled = false; btn.textContent = '开始执行';
    });

    api.onTaskProgress(p => {
        if (p.phase === 'start') progressEl.innerHTML = `<div class="alert info" style="margin-top:14px">任务 ${esc(p.taskId)} 开始执行，共 ${esc(p.total)} 台主机</div>`;
        else if (p.phase === 'running') {
            const pct = Math.round((p.done / p.total) * 100);
            progressEl.innerHTML = `<div class="card" style="padding:14px;margin-top:14px"><div style="display:flex;justify-content:space-between;font-size:12.5px;margin-bottom:8px"><span>执行进度 ${p.done}/${p.total}</span><span class="muted">最近：${esc(p.host || '')} · ${p.status === 'success' ? '成功' : '失败'}</span></div><div style="height:6px;background:#eef1f7;border-radius:3px;overflow:hidden"><div style="height:100%;width:${pct}%;background:var(--primary);transition:width .2s"></div></div></div>`;
        }
    });

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
            a.href = URL.createObjectURL(blob); a.download = res.filename; a.click();
            URL.revokeObjectURL(a.href);
            toast('结果已导出', 'success');
        }
    });
    detailModal.querySelectorAll('[data-close]').forEach(el => el.addEventListener('click', () => detailModal.classList.remove('open')));

    /* ---------------- 定时任务（沿用原逻辑） ---------------- */
    const scheduleTbody = root.querySelector('#schedule-tbody');
    const scheduleModal = root.querySelector('#schedule-modal');

    const refreshSchedules = async () => {
        try {
            schedules = await api.schedules.list();
            scheduleTbody.innerHTML = schedules.length ? schedules.map(scheduleRow).join('') : emptyRow(8, '暂无定时任务');
        } catch (err) { scheduleTbody.innerHTML = emptyRow(8, '定时任务加载失败：' + err.message); }
    };
    const paintScheduleHosts = (selected) => {
        const g = root.querySelector('#sc-host-grid');
        g.innerHTML = hosts.length ? hosts.map(h => `
            <label class="check-item"><input type="checkbox" data-host="${esc(h.id)}" ${selected.includes(h.id) ? 'checked' : ''}><span>${esc(h.name)}<br><span class="mono muted">${esc(h.ip)}</span></span></label>`).join('') : '<div class="empty">暂无主机</div>';
        const update = () => {
            root.querySelector('#sc-host-count').textContent = g.querySelectorAll('input:checked').length;
            g.querySelectorAll('.check-item').forEach(item => item.classList.toggle('checked', item.querySelector('input').checked));
        };
        g.onchange = update; update();
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
    root.querySelector('#btn-add-schedule').addEventListener('click', () => { if (!guardAdmin('新增定时任务')) return; openScheduleModal(null); });
    root.querySelector('#btn-reload-schedules').addEventListener('click', refreshSchedules);
    scheduleModal.querySelectorAll('[data-close]').forEach(el => el.addEventListener('click', () => scheduleModal.classList.remove('open')));
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
            mode, time: root.querySelector('#sc-time').value.trim(),
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
        if (res && res.ok) { toast(`定时任务已保存：${res.schedule.scheduleText}`, 'success'); scheduleModal.classList.remove('open'); await refreshSchedules(); }
        else root.querySelector('#sc-msg').innerHTML = `<span class="text-danger">${esc((res && res.message) || '保存失败')}</span>`;
    });
    scheduleTbody.addEventListener('change', async e => {
        const input = e.target.closest('[data-toggle]');
        if (!input) return;
        if (!guardAdmin('启停定时任务')) { input.checked = !input.checked; return; }
        const res = await api.schedules.toggle(input.dataset.toggle, input.checked);
        if (res && res.ok) { toast(`已${input.checked ? '启用' : '停用'}，下次执行：${res.schedule.nextRunText}`, 'success'); await refreshSchedules(); }
        else { input.checked = !input.checked; toast((res && res.message) || '操作失败', 'danger'); }
    });
    scheduleTbody.addEventListener('click', async e => {
        const btn = e.target.closest('[data-act]');
        if (!btn) return;
        const id = btn.closest('tr').dataset.id;
        const schedule = schedules.find(s => s.id === id);
        if (btn.dataset.act === 'edit') { if (!guardAdmin('编辑定时任务')) return; openScheduleModal(schedule); }
        else if (btn.dataset.act === 'delete') {
            if (!guardAdmin('删除定时任务')) return;
            if (!confirm(`确认删除定时任务「${schedule.name}」？`)) return;
            const res = await api.schedules.remove(id);
            if (res && res.ok) { toast('已删除', 'success'); await refreshSchedules(); } else toast('删除失败', 'danger');
        } else if (btn.dataset.act === 'run') {
            if (!guardWrite('立即执行')) return;
            btn.textContent = '执行中...'; btn.disabled = true;
            const res = await api.schedules.runNow(id);
            btn.textContent = '立即执行'; btn.disabled = false;
            toast(res && res.ok ? `已触发：${res.status}` : ((res && res.message) || '触发失败'), res && res.ok && res.status !== 'failed' ? 'success' : 'warn');
            await refreshSchedules(); await refreshHistory();
        }
    });
    api.onScheduleProgress(p => {
        if (p.phase === 'start') toast(`定时任务「${p.name}」开始执行（${p.trigger === 'manual' ? '手动' : '定时'}）`, 'info');
        if (p.phase === 'done') refreshSchedules();
    });

    applyReadonly(root);
    await refreshHistory();
    await refreshSchedules();
}
