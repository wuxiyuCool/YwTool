/**
 * 任务执行页（终端工作台，Xshell 风格）
 * ------------------------------------------------------------------
 * 顶部标签：终端工作台 / 批量执行 / 定时任务 / 执行历史
 *   - 终端工作台：左侧主机列表 → 打开交互式 SSH 会话（多标签），零依赖轻量终端仿真
 *     （ANSI SGR 颜色 + 行模式输入 + 滚动缓冲 + 快捷命令栏），数据流 terminal:open/input + terminal:data/exit 推送
 *   - 批量执行：命令/脚本先经敏感词校验，主进程并发 SSH，实时进度推送
 *   - 定时任务：schedules:list|save|toggle|delete|runNow（调度器 30s 心跳）
 *   - 执行历史：tasks:list / tasks:detail / tasks:export
 */
import { api, demoMode } from '../api.js';
import { esc, toast, demoBanner, emptyRow, loadingRow, shortTime, guardWrite, guardAdmin, applyReadonly } from '../ui.js';

let hosts = [];
let scripts = [];
let history = [];
let schedules = [];
let lastSelected = [];
let editingScheduleId = null;

/* ---------------- 终端会话状态 ---------------- */
/** sessionId → { hostName, outEl, scrollback:[], ansi, lastLine } */
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

/* ---------------- 轻量 ANSI 终端 ---------------- */

/** SGR 前景/背景色映射（标准 16 色 + 粗体），其余转义序列安全剥离 */
const FG = { 30: '#3a3a3a', 31: '#e05555', 32: '#57c26b', 33: '#e0b45a', 34: '#5a9de0', 35: '#c25ad1', 36: '#4ec9c9', 37: '#d5d5d5', 90: '#7a7a7a', 91: '#ff6b6b', 92: '#6ee787', 93: '#ffd97a', 94: '#7ab8ff', 95: '#e57bff', 96: '#6fe7e7', 97: '#ffffff' };
const BG = { 40: '#000', 41: '#5a1d1d', 42: '#1d5a2a', 43: '#5a4a1d', 44: '#1d3a5a', 45: '#5a1d5a', 46: '#1d5a5a', 47: '#c0c0c0', 100: '#3a3a3a', 101: '#8a3a3a', 102: '#3a8a4a', 103: '#8a7a3a', 104: '#3a5a8a', 105: '#8a3a8a', 106: '#3a8a8a', 107: '#ffffff' };

/** 把一段 ANSI 文本渲染成 HTML span 序列；传入/返回样式状态以支持跨 chunk 着色 */
function ansiToHtml(text, state) {
    const st = state || { fg: null, bg: null, bold: false };
    let out = '';
    let i = 0;
    const openSpan = () => `<span style="${st.fg ? `color:${st.fg};` : ''}${st.bg ? `background:${st.bg};` : ''}${st.bold ? 'font-weight:700;' : ''}">`;
    let pending = '';
    const flush = () => { if (pending) { out += openSpan() + escHtml(pending); pending = ''; } };
    while (i < text.length) {
        const ch = text[i];
        if (ch === '\x1b') {
            flush();
            // OSC：ESC ] ... (BEL | ST) —— 窗口标题等，整段丢弃
            if (text[i + 1] === ']') {
                const end = text.indexOf('\x07', i + 2);
                const st2 = text.indexOf('\x1b\\', i + 2);
                const stop = end >= 0 ? (st2 >= 0 && st2 < end ? st2 : end) : st2;
                i = stop >= 0 ? (text[stop] === '\x1b' ? stop + 2 : stop + 1) : text.length;
                continue;
            }
            // CSI：ESC [ 私有参数 中间字节 终止字节（含 ? 等，覆盖 \x1b[?1034h、\x1b[2J、\x1b[?25l）
            const csi = /^\x1b\[([\x30-\x3f]*)([\x20-\x2f]*)([\x40-\x7e])/.exec(text.slice(i));
            if (csi) {
                if (csi[3] === 'm') {
                    const codes = (csi[1] || '0').split(';').map(x => (x === '' ? 0 : Number(x)));
                    if (!codes.length || codes[0] === 0) { st.fg = null; st.bg = null; st.bold = false; }
                    codes.forEach(c => {
                        if (c === 1) st.bold = true;
                        else if (c === 22) st.bold = false;
                        else if (c === 39) st.fg = null;
                        else if (c === 49) st.bg = null;
                        else if (c >= 30 && c <= 37 || c >= 90 && c <= 97) st.fg = FG[c];
                        else if (c >= 40 && c <= 47 || c >= 100 && c <= 107) st.bg = BG[c];
                    });
                }
                // 其它 CSI（光标移动/清屏等）：忽略指令本身，行模式不重绘
                i += csi[0].length;
                continue;
            }
            // 其它 ESC 序列（如 ESC ( B）：跳过 2 字节
            i += 2;
            continue;
        }
        // PTY 行结尾是 \r\n：必须输出换行，否则所有内容会横向堆在一行
        if (ch === '\r') {
            out += openSpan() + escHtml(pending) + '</span><br>'; pending = '';
            i += (text[i + 1] === '\n' ? 2 : 1);
            continue;
        }
        if (ch === '\b') { pending = pending.slice(0, -1); i++; continue; }
        if (ch === '\n') { out += openSpan() + escHtml(pending) + '</span><br>'; pending = ''; i++; continue; }
        if (ch === '\t') { pending += '    '; i++; continue; }
        if (ch === '\u0007' || ch.charCodeAt(0) < 32) { i++; continue; }  // 控制字符（BEL 等）丢弃
        pending += ch;
        i++;
    }
    return { html: out + (pending ? openSpan() + escHtml(pending) : ''), state: st };
}

function escHtml(s) {
    return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
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
                        <span class="muted" style="font-size:12px">支持多会话并行；行模式交互，ANSI 彩色输出</span>
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
                <div class="wt-input-row">
                    <span class="wt-prompt">$</span>
                    <textarea class="input mono wt-input" id="wt-input" rows="1" placeholder="输入命令后回车发送（Shift+回车换行；需先连接主机）" autocomplete="off" spellcheck="false"></textarea>
                    <button class="btn btn-primary btn-sm" id="wt-send" data-write>发送</button>
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

    const focusActiveTerm = () => {
        const s = termSessions.get(activeSession);
        if (s && s.outEl) s.outEl.scrollTop = s.outEl.scrollHeight;
    };

    const showSession = (id) => {
        activeSession = id;
        const s = termSessions.get(id);
        termBodyEl.querySelectorAll('.wt-term-out').forEach(el => { el.style.display = 'none'; });
        const ph = termBodyEl.querySelector('#wt-term-placeholder');
        if (ph) ph.style.display = 'none';
        if (s) {
            if (!s.outEl) {
                s.outEl = document.createElement('div');
                s.outEl.className = 'wt-term-out mono';
                s.outEl.innerHTML = s.bufferHtml || '';
                termBodyEl.appendChild(s.outEl);
            } else {
                s.outEl.style.display = '';
            }
            inputEl.placeholder = s.hostName ? `发送到 ${s.hostName}` : '输入命令后回车发送';
        }
        paintSessionTabs();
        focusActiveTerm();
        inputEl.focus();
    };

    const appendToSession = (id, text) => {
        const s = termSessions.get(id);
        if (!s) return;
        const res = ansiToHtml(text, s.ansi);
        s.ansi = res.state;
        const el = s.outEl && s.outEl.parentNode ? s.outEl : null;
        if (el) {
            el.insertAdjacentHTML('beforeend', res.html);
            // 滚动缓冲上限：超过 4000 行截断旧内容
            if (el.childElementCount > 4200 || el.innerHTML.length > 400000) {
                el.innerHTML = el.innerHTML.slice(-200000);
            }
            el.scrollTop = el.scrollHeight;
        } else {
            s.bufferHtml = (s.bufferHtml || '') + res.html;
        }
    };

    const openSession = async (hostId) => {
        if (!guardWrite('打开终端会话')) return;
        const host = hosts.find(h => h.id === hostId);
        if (!host) return;
        const btn = hostListEl.querySelector(`[data-connect="${hostId}"]`);
        if (btn) { btn.disabled = true; btn.textContent = '连接中'; }
        const res = await api.terminal.open({ hostId, cols: 100, rows: 30 });
        if (btn) { btn.disabled = false; btn.textContent = '连接'; }
        if (!res || !res.ok) { toast((res && res.message) || '连接失败', 'danger'); return; }
        termSessions.set(res.sessionId, { hostName: res.hostName, hostId, ansi: {}, bufferHtml: '' });
        showSession(res.sessionId);
        appendToSession(res.sessionId, `\x1b[36m已连接 ${res.hostName}\x1b[0m\r\n`);
    };

    const closeSession = async (id) => {
        await api.terminal.close(id);
        const s = termSessions.get(id);
        if (s && s.outEl && s.outEl.parentNode) s.outEl.remove();
        termSessions.delete(id);
        if (activeSession === id) {
            activeSession = termSessions.keys().next().value || null;
            if (activeSession) showSession(activeSession);
            else {
                termBodyEl.querySelectorAll('.wt-term-out').forEach(el => el.remove());
                const ph = document.createElement('div');
                ph.className = 'wt-term-placeholder'; ph.id = 'wt-term-placeholder';
                ph.innerHTML = '<div>未打开会话</div>';
                termBodyEl.appendChild(ph);
                paintSessionTabs();
            }
        } else {
            paintSessionTabs();
        }
    };

    const sendInput = async (text) => {
        if (!activeSession) { toast('请先从左侧连接一台主机', 'warn'); return; }
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
    const doSend = () => {
        const v = inputEl.value;
        if (!v) { sendInput('\n'); return; }
        sendInput(v + '\n');
        inputEl.value = '';
        autoGrow();
    };
    const autoGrow = () => {
        inputEl.style.height = 'auto';
        inputEl.style.height = Math.min(inputEl.scrollHeight, 120) + 'px';
    };
    root.querySelector('#wt-send').addEventListener('click', doSend);
    inputEl.addEventListener('input', autoGrow);
    inputEl.addEventListener('keydown', e => {
        if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); doSend(); }
    });

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
            if (c) { inputEl.value = c.cmd; inputEl.focus(); }
        }
    });
    root.querySelector('#wt-quick-add').addEventListener('click', () => {
        const cmd = (inputEl.value || '').trim() || prompt('输入要保存为快捷命令的内容：');
        if (!cmd) return;
        const label = prompt('命令别名（显示在按钮上）：', cmd.slice(0, 12)) || cmd.slice(0, 12);
        quickCmds.push({ label, cmd });
        saveQuickCmds();
        refreshQuick();
        toast('已加入快捷命令栏', 'success');
    });
    function refreshQuick() { root.querySelector('#wt-quick-chips').innerHTML = quickCmdHtml(); }

    // 订阅推送（会话数据 / 退出）
    termUnsubs.push(api.terminal.onData(({ sessionId, chunk }) => appendToSession(sessionId, chunk)));
    termUnsubs.push(api.terminal.onExit(({ sessionId, message }) => {
        if (termSessions.has(sessionId)) {
            appendToSession(sessionId, `\r\n\x1b[33m${message || '会话已结束'}\x1b[0m\r\n`);
            const s = termSessions.get(sessionId);
            if (s) s.closed = true;
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
