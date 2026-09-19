/**
 * 系统运维 · 凭据台账（仅系统管理员可见）
 * 数据流：ledger:list（聚合掩码列表）→ ledger:reveal（登录口令二次校验后解密单条）
 *
 * 交互约定：
 *   - 明文只按需拉取；展示 30 秒后自动回掩码（防挂机窥屏）
 *   - 首次解密需输入当前账号登录口令；同一页面会话内查看其它条目免重复输入
 *     （服务端每条仍做口令校验 + 审计留痕，缓存仅存在于内存）
 *   - 台账本身只读聚合；新增 / 修改凭据请前往对应管理页（业务系统 / 数据源 / 主机）
 */
import { api, demoMode } from '../api.js';
import { esc, toast, demoBanner, emptyRow, loadingRow, guardAdmin } from '../ui.js';

const KIND_BADGE = { account: 'blue', db: 'purple', host: 'amber' };
const KIND_FILTERS = [
    { id: 'all', label: '全部' },
    { id: 'account', label: '业务系统' },
    { id: 'db', label: '数据源' },
    { id: 'host', label: '主机 SSH' }
];
const AUTO_HIDE_MS = 30000;

/** 页面级状态：切换页面后 render() 重建并清空 */
let rows = [];
let filter = 'all';
let keyword = '';
/** 'kind:id' → { plain, timer } */
const revealed = new Map();
/** 最近一次校验通过的登录口令（仅内存，随页面销毁） */
let sessionPass = '';

const rowKey = r => `${r.kind}:${r.id}`;

function clearAllRevealed() {
    revealed.forEach(entry => clearTimeout(entry.timer));
    revealed.clear();
    sessionPass = '';
}

function displayPassword(r) {
    const hit = revealed.get(rowKey(r));
    return hit ? `<span class="mono ledger-plain">${esc(hit.plain)}</span>`
        : `<span class="mono muted">${esc(r.passwordMasked || '（未保存口令）')}</span>`;
}

function actionButtons(r) {
    if (!r.hasPassword) return '<span class="muted" style="font-size:12px">无口令</span>';
    const open = revealed.has(rowKey(r));
    return `
        <button class="btn-link" data-act="reveal" data-id="${esc(r.id)}" data-kind="${esc(r.kind)}">${open ? '隐藏' : '查看'}</button>
        ${open ? `<button class="btn-link" data-act="copy" data-id="${esc(r.id)}" data-kind="${esc(r.kind)}">复制</button>` : ''}
        <button class="btn-link" data-goto="${esc(r.goto)}" title="前往对应管理页维护">管理</button>`;
}

function rowHtml(r) {
    return `
    <tr data-key="${esc(rowKey(r))}">
        <td><span class="badge ${KIND_BADGE[r.kind] || 'gray'}">${esc(r.kindLabel)}</span></td>
        <td><strong>${esc(r.name)}</strong></td>
        <td class="mono" style="font-size:12px">${esc(r.target)}</td>
        <td class="mono">${esc(r.user)}</td>
        <td class="ledger-pwd-cell">${displayPassword(r)}</td>
        <td class="muted" style="font-size:12px">${esc(r.note || '-')}</td>
        <td class="muted" style="font-size:12px">${esc(r.updatedAt || '-')}</td>
        <td>${actionButtons(r)}</td>
    </tr>`;
}

function filteredRows() {
    const kw = keyword.trim().toLowerCase();
    return rows.filter(r =>
        (filter === 'all' || r.kind === filter) &&
        (!kw || `${r.name} ${r.user} ${r.target} ${r.note}`.toLowerCase().includes(kw)));
}

/** 口令确认弹窗：确认后回调 */
function askPass(root, onOk) {
    if (sessionPass) { onOk(sessionPass); return; }
    const mask = document.createElement('div');
    mask.className = 'modal-mask open';
    mask.innerHTML = `
    <div class="modal" style="width:400px">
        <div class="modal-header"><h3>解密确认</h3><button class="modal-close" data-close>×</button></div>
        <div class="modal-body">
            <div class="alert info">
                <span>查看明文凭据需要输入<strong>当前登录账号的口令</strong>进行二次校验；每次查看都会写入审计日志。</span>
            </div>
            <div class="form-item" style="margin-top:12px">
                <label>登录口令</label>
                <input class="input" id="ld-pass" type="password" autocomplete="current-password">
            </div>
            <div class="form-hint" id="ld-pass-msg"></div>
        </div>
        <div class="modal-footer">
            <button class="btn btn-ghost" data-close>取消</button>
            <button class="btn btn-primary" id="ld-pass-ok">确认查看</button>
        </div>
    </div>`;
    document.body.appendChild(mask);
    const close = () => mask.remove();
    mask.querySelectorAll('[data-close]').forEach(el => el.addEventListener('click', close));
    const input = mask.querySelector('#ld-pass');
    setTimeout(() => input.focus(), 50);
    const submit = async () => {
        const pass = input.value;
        if (!pass) { mask.querySelector('#ld-pass-msg').innerHTML = '<span class="text-danger">请输入登录口令</span>'; return; }
        const btn = mask.querySelector('#ld-pass-ok');
        btn.disabled = true;
        btn.textContent = '校验中...';
        try {
            await onOk(pass);
            close();
        } catch (err) {
            mask.querySelector('#ld-pass-msg').innerHTML = `<span class="text-danger">${esc(err.message || '解密失败')}</span>`;
        } finally {
            btn.disabled = false;
            btn.textContent = '确认查看';
        }
    };
    mask.querySelector('#ld-pass-ok').addEventListener('click', submit);
    input.addEventListener('keydown', e => { if (e.key === 'Enter') submit(); });
}

export function render() {
    clearAllRevealed();
    return `
    ${demoBanner(demoMode)}
    <div class="card">
        <div class="card-header">
            <div>
                <div class="card-title">凭据台账</div>
                <div class="card-desc">业务系统 / 数据源 / 主机 SSH 的账号口令统一台账 · AES-256-GCM 加密存储 · 解密查看仅系统管理员且全程审计</div>
            </div>
            <div class="toolbar" style="margin:0">
                <input class="input" id="ledger-search" placeholder="搜索名称 / 账号 / 地址" style="width:200px">
                <button class="btn btn-ghost btn-sm" id="ledger-refresh">刷新</button>
                <button class="btn btn-ghost btn-sm" data-goto="accounts">登记新凭据</button>
            </div>
        </div>
        <div class="tabs" id="ledger-tabs">
            ${KIND_FILTERS.map(f => `<div class="tab ${f.id === filter ? 'active' : ''}" data-kind="${f.id}">${f.label}</div>`).join('')}
        </div>
        <div class="table-wrap">
            <table class="table">
                <thead><tr>
                    <th>类型</th><th>名称</th><th>地址</th><th>账号</th><th>口令</th><th>备注</th><th>最近更新</th><th>操作</th>
                </tr></thead>
                <tbody id="ledger-tbody">${loadingRow(8)}</tbody>
            </table>
        </div>
        <div class="form-hint" id="ledger-summary"></div>
    </div>`;
}

async function paint(root) {
    const tbody = root.querySelector('#ledger-tbody');
    const list = filteredRows();
    tbody.innerHTML = list.length ? list.map(rowHtml).join('') : emptyRow(8, rows.length ? '无匹配条目' : '暂无凭据');
    const withPwd = rows.filter(r => r.hasPassword).length;
    root.querySelector('#ledger-summary').textContent =
        `共 ${rows.length} 条凭据（含口令 ${withPwd} 条）· 明文展示 ${revealed.size} 条 · 30 秒自动隐藏`;
}

export async function mount(root) {
    const tbody = root.querySelector('#ledger-tbody');

    const load = async () => {
        tbody.innerHTML = loadingRow(8);
        try {
            const res = await api.ledger.list();
            rows = Array.isArray(res) ? res : [];
        } catch (err) {
            rows = [];
            toast('台账加载失败：' + err.message, 'danger');
        }
        await paint(root);
    };

    root.querySelector('#ledger-refresh').addEventListener('click', () => { clearAllRevealed(); load(); });
    root.querySelector('#ledger-search').addEventListener('input', e => { keyword = e.target.value; paint(root); });
    root.querySelector('#ledger-tabs').addEventListener('click', e => {
        const tab = e.target.closest('.tab');
        if (!tab) return;
        filter = tab.dataset.kind;
        root.querySelectorAll('#ledger-tabs .tab').forEach(t => t.classList.toggle('active', t === tab));
        paint(root);
    });

    tbody.addEventListener('click', e => {
        const btn = e.target.closest('[data-act]');
        if (!btn) return;
        const key = `${btn.dataset.kind}:${btn.dataset.id}`;
        const row = rows.find(r => rowKey(r) === key);
        if (!row) return;

        if (btn.dataset.act === 'copy') {
            const hit = revealed.get(key);
            if (!hit) return;
            copyText(hit.plain);
            return;
        }

        if (btn.dataset.act === 'reveal') {
            if (revealed.has(key)) { hideRow(root, row); return; }
            if (!guardAdmin('解密查看凭据')) return;
            askPass(root, async pass => {
                const res = await api.ledger.reveal({ kind: row.kind, id: row.id, password: pass });
                if (!res || !res.ok) throw new Error((res && res.message) || '解密失败');
                sessionPass = pass;
                const timer = setTimeout(() => hideRow(root, row), AUTO_HIDE_MS);
                revealed.set(key, { plain: res.password, timer });
                await paint(root);
                toast(`已显示「${row.name}」的明文口令，30 秒后自动隐藏`, 'success');
            });
        }
    });

    await load();
}

function hideRow(root, row) {
    const hit = revealed.get(rowKey(row));
    if (hit) { clearTimeout(hit.timer); revealed.delete(rowKey(row)); }
    paint(root);
}

function copyText(text) {
    if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(text).then(
            () => toast('口令已复制到剪贴板', 'success'),
            () => toast('复制失败，请手动选中', 'warn'));
        return;
    }
    const ta = document.createElement('textarea');
    ta.value = text;
    document.body.appendChild(ta);
    ta.select();
    document.execCommand('copy');
    ta.remove();
    toast('口令已复制到剪贴板', 'success');
}
