/**
 * 安全运维 · 网络安全工作台
 * 四个视图：
 *   请求构造 —— 类 Postman：任意 method/URL/headers/body 发送、修改后重发、收藏为案例
 *   抓包代理 —— 类 BurpSuite(HTTP)：127.0.0.1 本地代理，流水实时刷新，支持断点改包重放
 *   案例库   —— 保存的请求定义（含 headers/body），可载入重放
 *   历史     —— 手工发送与抓包记录的滚动历史（200 条），可载入重放
 * 边界说明：HTTPS 走 CONNECT 隧道直通（仅记录域名与流量），不做 MITM 解密。
 */
import { api, demoMode } from '../api.js';
import { esc, toast, demoBanner, emptyRow, guardAdmin, applyReadonly } from '../ui.js';

const METHODS = ['GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'HEAD', 'OPTIONS'];
const TABS = [
    { id: 'send', label: '请求构造' },
    { id: 'proxy', label: '抓包代理' },
    { id: 'cases', label: '案例库' },
    { id: 'history', label: '历史' }
];

let root = null;
let currentTab = 'send';
let cases = [];
let history = [];
/** 抓包流水（仅本页内存，历史落库在 apiHistory） */
let packets = [];
/** 断点等待队列 */
let bpQueue = [];
let bpShowing = false;
let unsubPacket = null;
let unsubBp = null;

const statusBadge = st => {
    if (st === 'error' || st === 'dropped' || Number(st) >= 400) return `<span class="badge red">${esc(String(st))}</span>`;
    if (st === 'tunnel') return '<span class="badge gray">隧道</span>';
    if (Number(st) >= 200 && Number(st) < 400) return `<span class="badge green">${esc(String(st))}</span>`;
    return `<span class="badge blue">${esc(String(st))}</span>`;
};

/* ------------------------------------------------------------------
 * 视图
 * ------------------------------------------------------------------ */

function sendPane() {
    return `
    <div class="pane" data-tab="send">
        <div class="toolbar">
            <select class="select" id="ns-method" style="width:110px">${METHODS.map(m => `<option>${m}</option>`).join('')}</select>
            <input class="input mono" id="ns-url" placeholder="http://127.0.0.1:8080/api/status" style="flex:1;min-width:260px">
            <input class="input" id="ns-timeout" type="number" min="1000" step="1000" value="30000" title="超时（毫秒）" style="width:92px">
            <button class="btn btn-primary" data-write id="ns-send">发送</button>
            <button class="btn btn-ghost" data-write id="ns-save-case" title="把当前请求收藏为案例">收藏</button>
        </div>
        <div class="grid-2" style="align-items:start">
            <div>
                <div class="form-item">
                    <label>Headers（JSON 对象）</label>
                    <textarea class="textarea code-input" id="ns-headers" rows="6" spellcheck="false" placeholder='{"Content-Type": "application/json", "Authorization": "***"}'></textarea>
                </div>
                <div class="form-item">
                    <label>Body（GET/HEAD 自动忽略）</label>
                    <textarea class="textarea code-input" id="ns-body" rows="8" spellcheck="false" placeholder='{"key": "value"}'></textarea>
                </div>
            </div>
            <div>
                <div class="card-title" style="margin-bottom:8px">响应</div>
                <div class="toolbar" style="margin:0 0 8px">
                    <span id="ns-resp-meta" class="muted" style="font-size:12.5px">尚未发送</span>
                </div>
                <pre class="code-output" id="ns-resp-body">—</pre>
                <details style="margin-top:8px"><summary class="muted" style="font-size:12px;cursor:pointer">响应头</summary>
                    <pre class="code-output" id="ns-resp-headers" style="margin-top:6px">—</pre>
                </details>
            </div>
        </div>
        <div class="form-hint">提示：修改参数后再次点击「发送」即为重放；「抓包代理」断点里被暂存的请求也在这里改包重放。</div>
    </div>`;
}

function proxyPane() {
    return `
    <div class="pane" data-tab="proxy" style="display:none">
        <div class="alert info">
            <span>把待调试应用的 HTTP(S) 代理指向 <strong class="mono">127.0.0.1:端口</strong> 即可捕获流量。
            明文 HTTP 可断点改包重放；HTTPS 仅建立隧道（记录域名与字节数，不解密内容）。</span>
        </div>
        <div class="toolbar">
            <label class="muted" style="font-size:12.5px">端口</label>
            <input class="input" id="np-port" type="number" min="1024" max="65535" value="8899" style="width:96px">
            <label class="switch" title="开启后 HTTP 请求先暂停，等待你在界面里修改/放行">
                <input type="checkbox" id="np-breakpoints"><span class="track"></span>
            </label>
            <span class="muted" style="font-size:12.5px">断点改包</span>
            <button class="btn btn-primary btn-sm" data-write id="np-start">启动代理</button>
            <button class="btn btn-ghost btn-sm" id="np-stop" disabled>停止</button>
            <div class="spacer"></div>
            <span class="muted" id="np-stats" style="font-size:12px"></span>
            <button class="btn btn-ghost btn-sm" id="np-clear">清屏</button>
        </div>
        <div class="table-wrap" style="max-height:440px;overflow:auto">
            <table class="table">
                <thead><tr><th style="width:130px">时间</th><th style="width:70px">方法</th><th>URL / 域名</th><th style="width:80px">状态</th><th style="width:80px">耗时</th><th style="width:90px">大小</th></tr></thead>
                <tbody id="np-tbody">${emptyRow(6, '代理未启动')}</tbody>
            </table>
        </div>
    </div>`;
}

function casesPane() {
    return `
    <div class="pane" data-tab="cases" style="display:none">
        <div class="table-wrap">
            <table class="table">
                <thead><tr><th>名称</th><th style="width:80px">方法</th><th>URL</th><th style="width:150px">更新时间</th><th style="width:120px">操作</th></tr></thead>
                <tbody id="nc-tbody">${emptyRow(5, '暂无案例')}</tbody>
            </table>
        </div>
    </div>`;
}

function historyPane() {
    return `
    <div class="pane" data-tab="history" style="display:none">
        <div class="toolbar">
            <div class="spacer"></div>
            <button class="btn btn-ghost btn-sm" data-write id="nh-clear">清空历史</button>
        </div>
        <div class="table-wrap">
            <table class="table">
                <thead><tr><th style="width:140px">时间</th><th style="width:70px">来源</th><th style="width:80px">方法</th><th>URL</th><th style="width:80px">状态</th><th style="width:80px">耗时</th><th style="width:110px">操作</th></tr></thead>
                <tbody id="nh-tbody">${emptyRow(7, '暂无记录')}</tbody>
            </table>
        </div>
    </div>`;
}

export function render() {
    return `
    ${demoBanner(demoMode)}
    <div class="card">
        <div class="card-header">
            <div>
                <div class="card-title">网络安全工作台</div>
                <div class="card-desc">请求构造重放（类 Postman）· 本地抓包代理与断点改包（类 BurpSuite）· 仅本机 127.0.0.1，操作均记审计</div>
            </div>
        </div>
        <div class="tabs" id="ns-tabs">
            ${TABS.map(t => `<div class="tab ${t.id === currentTab ? 'active' : ''}" data-tab="${t.id}">${t.label}</div>`).join('')}
        </div>
        ${sendPane()}${proxyPane()}${casesPane()}${historyPane()}
    </div>
    <div class="modal-mask" id="bp-modal">
        <div class="modal etl-modal" style="width:820px;max-width:94vw">
            <div class="modal-header">
                <h3 id="bp-title">断点：请求已暂存</h3>
                <span class="badge amber" id="bp-count"></span>
                <button class="modal-close" data-bp-drop>×</button>
            </div>
            <div class="modal-body">
                <div class="form-row">
                    <div class="form-item" style="flex:0 0 110px">
                        <label>方法</label>
                        <input class="input mono" id="bp-method">
                    </div>
                    <div class="form-item" style="flex:1">
                        <label>URL</label>
                        <input class="input mono" id="bp-url">
                    </div>
                </div>
                <div class="form-item">
                    <label>Headers（JSON）</label>
                    <textarea class="textarea code-input" id="bp-headers" rows="6" spellcheck="false"></textarea>
                </div>
                <div class="form-item">
                    <label>Body（UTF-8 文本；二进制内容请勿改动后转发）</label>
                    <textarea class="textarea code-input" id="bp-body" rows="6" spellcheck="false"></textarea>
                </div>
                <div class="form-hint" id="bp-hint"></div>
            </div>
            <div class="modal-footer">
                <button class="btn btn-danger" id="bp-drop">丢弃请求</button>
                <div class="spacer"></div>
                <button class="btn btn-ghost" id="bp-forward">原样放行</button>
                <button class="btn btn-primary" id="bp-modified">修改后重放</button>
            </div>
        </div>
    </div>`;
}

/* ------------------------------------------------------------------
 * 逻辑
 * ------------------------------------------------------------------ */

function showTab(id) {
    currentTab = id;
    root.querySelectorAll('#ns-tabs .tab').forEach(t => t.classList.toggle('active', t.dataset.tab === id));
    root.querySelectorAll('.pane').forEach(p => { p.style.display = p.dataset.tab === id ? '' : 'none'; });
}

function collectRequest() {
    let headers = {};
    const raw = root.querySelector('#ns-headers').value.trim();
    if (raw) {
        try { headers = JSON.parse(raw); } catch (e) { throw new Error('Headers 不是合法 JSON'); }
    }
    return {
        method: root.querySelector('#ns-method').value,
        url: root.querySelector('#ns-url').value.trim(),
        headers,
        body: root.querySelector('#ns-body').value,
        timeoutMs: Number(root.querySelector('#ns-timeout').value) || 30000
    };
}

async function doSend() {
    if (!guardAdmin('发送外部请求')) return;
    let req;
    try { req = collectRequest(); } catch (err) { toast(err.message, 'warn'); return; }
    if (!req.url) { toast('请输入 URL', 'warn'); return; }
    const btn = root.querySelector('#ns-send');
    btn.disabled = true; btn.textContent = '发送中...';
    const meta = root.querySelector('#ns-resp-meta');
    meta.textContent = '请求中...';
    try {
        const res = await api.netsec.send(req);
        if (res && res.ok) {
            meta.innerHTML = `${statusBadge(res.status)} <span class="muted">${esc(res.durationMs)} ms · ${esc((res.sizeBytes / 1024).toFixed(1))} KB${res.truncated ? ' · 超过 5MB 已截断' : ''}</span>`;
            let body = String(res.body || '');
            if (/json/i.test(String((res.headers || {})['content-type'] || ''))) {
                try { body = JSON.stringify(JSON.parse(body), null, 2); } catch (e) { /* 原样展示 */ }
            }
            root.querySelector('#ns-resp-body').textContent = body || '(空响应体)';
            root.querySelector('#ns-resp-headers').textContent = JSON.stringify(res.headers || {}, null, 2);
        } else {
            meta.innerHTML = `<span class="badge red">失败</span> <span class="muted">${esc((res && res.message) || '未知错误')}</span>`;
            root.querySelector('#ns-resp-body').textContent = '—';
            root.querySelector('#ns-resp-headers').textContent = '—';
        }
        loadHistory();
    } finally {
        btn.disabled = false; btn.textContent = '发送';
    }
}

async function saveCase() {
    if (!guardAdmin('保存请求案例')) return;
    let req;
    try { req = collectRequest(); } catch (err) { toast(err.message, 'warn'); return; }
    if (!req.url) { toast('请输入 URL', 'warn'); return; }
    const name = prompt('案例名称', `${req.method} ${req.url.slice(0, 40)}`);
    if (!name) return;
    const res = await api.netsec.cases.save({ name, ...req, headers: JSON.stringify(req.headers || {}, null, 2) });
    toast(res && res.ok ? '案例已保存' : ((res && res.message) || '保存失败'), res && res.ok ? 'success' : 'danger');
    loadCases();
}

function fillForm(req) {
    root.querySelector('#ns-method').value = METHODS.includes(req.method) ? req.method : 'GET';
    root.querySelector('#ns-url').value = req.url || '';
    root.querySelector('#ns-headers').value = typeof req.headers === 'string' ? req.headers : JSON.stringify(req.headers || {}, null, 2);
    root.querySelector('#ns-body').value = req.body || '';
    showTab('send');
}

/* ---------------- 案例 / 历史 ---------------- */

async function loadCases() {
    try {
        cases = await api.netsec.cases.list();
        cases = Array.isArray(cases) ? cases : [];
    } catch (err) { cases = []; }
    const tbody = root.querySelector('#nc-tbody');
    tbody.innerHTML = cases.length ? cases.map(c => `
        <tr data-id="${esc(c.id)}">
            <td><strong>${esc(c.name)}</strong></td>
            <td><span class="badge blue">${esc(c.method || 'GET')}</span></td>
            <td class="mono" style="font-size:12px;word-break:break-all">${esc(c.url)}</td>
            <td class="muted" style="font-size:12px">${esc(c.updatedAt || '')}</td>
            <td>
                <button class="btn-link" data-act="load">载入</button>
                <button class="btn-link danger" data-act="del" data-write>删除</button>
            </td>
        </tr>`).join('') : emptyRow(5, '暂无案例，在「请求构造」里点收藏');
}

async function loadHistory() {
    try {
        history = await api.netsec.history(200);
        history = Array.isArray(history) ? history : [];
    } catch (err) { history = []; }
    const tbody = root.querySelector('#nh-tbody');
    tbody.innerHTML = history.length ? history.map(h => `
        <tr data-method="${esc(h.method)}" data-url="${esc(h.url)}">
            <td class="muted" style="font-size:12px">${esc(h.at || '')}</td>
            <td><span class="badge ${h.source === 'proxy' ? 'purple' : 'gray'}">${h.source === 'proxy' ? '抓包' : '发送'}</span></td>
            <td>${esc(h.method || '')}</td>
            <td class="mono" style="font-size:12px;word-break:break-all">${esc(h.url)}</td>
            <td>${statusBadge(h.status)}</td>
            <td class="muted">${esc(h.durationMs || 0)} ms</td>
            <td><button class="btn-link" data-act="replay">载入重放</button></td>
        </tr>`).join('') : emptyRow(7, '暂无记录');
}

/* ---------------- 抓包代理 ---------------- */

function paintPackets() {
    const tbody = root.querySelector('#np-tbody');
    tbody.innerHTML = packets.length ? packets.slice(0, 100).map(p => `
        <tr>
            <td class="muted" style="font-size:12px">${esc(p.at || '')}</td>
            <td>${esc(p.method || '')}</td>
            <td class="mono" style="font-size:12px;word-break:break-all">${esc(p.url)}</td>
            <td>${statusBadge(p.status || p.result || '')}</td>
            <td class="muted">${esc(p.durationMs || '')} ms</td>
            <td class="muted">${p.sizeBytes ? esc((p.sizeBytes / 1024).toFixed(1)) + ' KB' : '-'}</td>
        </tr>`).join('') : emptyRow(6, '等待流量...');
}

async function refreshProxyStatus() {
    const st = await api.netsec.proxy.status();
    if (!st) return;
    const startBtn = root.querySelector('#np-start');
    const stopBtn = root.querySelector('#np-stop');
    startBtn.disabled = !!st.running;
    stopBtn.disabled = !st.running;
    root.querySelector('#np-breakpoints').checked = !!st.breakpoints;
    root.querySelector('#np-stats').innerHTML = st.running
        ? `<span class="badge green">运行中 :${esc(st.port)}</span> · 请求 ${esc(st.stats.requests)} · 隧道 ${esc(st.stats.tunnels)} · ${(st.stats.bytes / 1024).toFixed(0)} KB`
        : '<span class="badge gray">未启动</span>';
}

/* ---------------- 断点弹窗 ---------------- */

const b64ToText = b64 => {
    try { return decodeURIComponent(escape(atob(b64))); } catch (e) { return ''; }
};
const textToB64 = text => {
    try { return btoa(unescape(encodeURIComponent(text))); } catch (e) { return ''; }
};

function showNextBreakpoint() {
    if (bpShowing || !bpQueue.length) return;
    const { id, record } = bpQueue.shift();
    bpShowing = true;
    root.querySelector('#bp-title').textContent = `断点：${record.method} ${record.url.length > 60 ? record.url.slice(0, 60) + '…' : record.url}`;
    root.querySelector('#bp-count').textContent = bpQueue.length ? `队列还有 ${bpQueue.length} 个` : '';
    root.querySelector('#bp-method').value = record.method;
    root.querySelector('#bp-url').value = record.url;
    root.querySelector('#bp-headers').value = JSON.stringify(record.headers || {}, null, 2);
    const text = b64ToText(record.body || '');
    root.querySelector('#bp-body').value = text;
    root.querySelector('#bp-hint').textContent = (record.body && !text) ? 'Body 非 UTF-8 文本（可能是二进制/压缩），请选择「原样放行」。' : '';
    root.querySelector('#bp-modal').dataset.bpId = id;
    root.querySelector('#bp-modal').classList.add('open');
}

function closeBreakpoint() {
    bpShowing = false;
    root.querySelector('#bp-modal').classList.remove('open');
    setTimeout(showNextBreakpoint, 50);
}

async function bpDecision(action, useEditor) {
    const id = root.querySelector('#bp-modal').dataset.bpId;
    if (!id) return;
    const payload = { id, action };
    if (useEditor) {
        let headers;
        try { headers = JSON.parse(root.querySelector('#bp-headers').value || '{}'); } catch (e) { toast('Headers 不是合法 JSON', 'warn'); return; }
        payload.modified = {
            method: root.querySelector('#bp-method').value.trim().toUpperCase(),
            url: root.querySelector('#bp-url').value.trim(),
            headers,
            body: textToB64(root.querySelector('#bp-body').value)
        };
    }
    const res = await api.netsec.decision(payload);
    if (res && !res.ok) toast(res.message, 'warn');
    closeBreakpoint();
}

/* ------------------------------------------------------------------
 * 挂载
 * ------------------------------------------------------------------ */

export async function mount(r) {
    root = r;

    root.querySelector('#ns-tabs').addEventListener('click', e => {
        const tab = e.target.closest('.tab');
        if (tab) showTab(tab.dataset.tab);
    });
    root.querySelector('#ns-send').addEventListener('click', doSend);
    root.querySelector('#ns-save-case').addEventListener('click', saveCase);

    root.querySelector('#np-start').addEventListener('click', async () => {
        if (!guardAdmin('启动抓包代理')) return;
        const res = await api.netsec.proxy.start({
            port: Number(root.querySelector('#np-port').value) || 8899,
            breakpoints: root.querySelector('#np-breakpoints').checked
        });
        toast(res && res.ok ? `代理已启动：127.0.0.1:${res.port}` : ((res && res.message) || '启动失败'), res && res.ok ? 'success' : 'danger');
        await refreshProxyStatus();
    });
    root.querySelector('#np-stop').addEventListener('click', async () => {
        if (!guardAdmin('停止抓包代理')) return;
        await api.netsec.proxy.stop();
        await refreshProxyStatus();
    });
    root.querySelector('#np-clear').addEventListener('click', () => { packets = []; paintPackets(); });

    root.querySelector('#nc-tbody').addEventListener('click', async e => {
        const btn = e.target.closest('[data-act]');
        if (!btn) return;
        const id = btn.closest('tr').dataset.id;
        const item = cases.find(c => c.id === id);
        if (!item) return;
        if (btn.dataset.act === 'load') fillForm(item);
        else if (btn.dataset.act === 'del') {
            if (!guardAdmin('删除请求案例')) return;
            if (!confirm(`删除案例「${item.name}」？`)) return;
            await api.netsec.cases.remove(id);
            await loadCases();
        }
    });

    root.querySelector('#nh-tbody').addEventListener('click', e => {
        const btn = e.target.closest('[data-act="replay"]');
        if (!btn) return;
        const tr = btn.closest('tr');
        fillForm({ method: tr.dataset.method, url: tr.dataset.url, headers: '', body: '' });
    });
    root.querySelector('#nh-clear').addEventListener('click', async () => {
        if (!guardAdmin('清空历史')) return;
        if (!confirm('清空网络安全工作台的全部历史记录？')) return;
        await api.netsec.clearHistory();
        await loadHistory();
    });

    root.querySelector('#bp-forward').addEventListener('click', () => bpDecision('forward', false));
    root.querySelector('#bp-modified').addEventListener('click', () => bpDecision('forward', true));
    root.querySelector('#bp-drop').addEventListener('click', () => bpDecision('drop', false));
    root.querySelector('[data-bp-drop]').addEventListener('click', () => bpDecision('drop', false));

    /* 实时推送订阅（重复 mount 时先退订） */
    if (unsubPacket) unsubPacket();
    if (unsubBp) unsubBp();
    unsubPacket = api.netsec.onPacket(packet => {
        packets.unshift(packet);
        if (packets.length > 300) packets.length = 300;
        if (currentTab === 'proxy') paintPackets();
        refreshProxyStatus().catch(() => {});
    });
    unsubBp = api.netsec.onBreakpoint(entry => {
        bpQueue.push(entry);
        showNextBreakpoint();
    });

    await Promise.all([loadCases(), loadHistory(), refreshProxyStatus(), paintPackets()]);
    applyReadonly(root);
}
