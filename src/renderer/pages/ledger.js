/**
 * 系统运维 · 凭据台账（仅系统管理员可见）
 * 数据流：ledger:list（聚合掩码列表）· ledger:unlock|lock|status（Vault 式解锁会话）
 *        ledger:reveal（解锁期内免口令解密，锁定态强制登录口令二次校验）· audit:query（解密留痕）
 *
 * Vault 参考的实用化设计：
 *   - 解锁会话：口令校验一次 → 5 分钟 TTL 内查看其它条目免重复输入，到期自动回锁（可手动上锁）
 *   - 到期治理：业务系统凭据支持 expiresAt，列表给出「已过期 / 即将到期」徽标与筛选
 *   - 快速登记：直接在台账生成强随机口令（带强度计）并入库（走 accounts:save，同受管理员约束）
 *   - 解密留痕：页内展开「近期解密记录」（读审计日志）
 *   - 明文 30 秒自动回显掩码；口令永不经列表接口下发
 */
import { api, demoMode } from '../api.js';
import { esc, toast, demoBanner, emptyRow, loadingRow, guardAdmin } from '../ui.js';

const KIND_BADGE = { account: 'blue', db: 'purple', host: 'amber', docker: 'gray' };
const KIND_FILTERS = [
    { id: 'all', label: '全部' },
    { id: 'account', label: '业务系统' },
    { id: 'db', label: '数据源' },
    { id: 'host', label: '主机 SSH' },
    { id: 'docker', label: 'Docker 端点' }
];
const AUTO_HIDE_MS = 30000;
const UNLOCK_POLL_MS = 10000;

let root = null;
let rows = [];
let filter = 'all';
let expireFilter = 'all';
let keyword = '';
/** 'kind:id' → { plain, timer } */
const revealed = new Map();
/** 解锁状态：{ unlocked, until } */
let unlockInfo = { unlocked: false, until: 0 };
let unlockTimer = null;

const rowKey = r => `${r.kind}:${r.id}`;

function clearAllRevealed() {
    revealed.forEach(entry => clearTimeout(entry.timer));
    revealed.clear();
}

/* ---------------- 到期计算 ---------------- */

function expireState(r) {
    if (!r.expiresAt) return null;
    const today = new Date();
    const target = new Date(`${r.expiresAt}T23:59:59`);
    if (Number.isNaN(target.getTime())) return null;
    const days = Math.ceil((target - today) / 86400000);
    if (days < 0) return { text: `已过期 ${-days} 天`, cls: 'red', days };
    if (days <= 7) return { text: `${days} 天后到期`, cls: 'amber', days };
    return { text: `${r.expiresAt}`, cls: 'green', days };
}

/* ---------------- 渲染 ---------------- */

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
    const exp = expireState(r);
    return `
    <tr data-key="${esc(rowKey(r))}">
        <td><span class="badge ${KIND_BADGE[r.kind] || 'gray'}">${esc(r.kindLabel)}</span></td>
        <td><strong>${esc(r.name)}</strong></td>
        <td class="mono" style="font-size:12px">${esc(r.target)}</td>
        <td class="mono">${esc(r.user)}</td>
        <td class="ledger-pwd-cell">${displayPassword(r)}</td>
        <td>${exp ? `<span class="badge ${exp.cls}">${esc(exp.text)}</span>` : '<span class="muted" style="font-size:12px">-</span>'}</td>
        <td class="muted" style="font-size:12px">${esc(r.note || '-')}</td>
        <td>${actionButtons(r)}</td>
    </tr>`;
}

function filteredRows() {
    const kw = keyword.trim().toLowerCase();
    return rows.filter(r => {
        if (filter !== 'all' && r.kind !== filter) return false;
        const exp = expireState(r);
        if (expireFilter === 'expired' && !(exp && exp.days < 0)) return false;
        if (expireFilter === 'soon' && !(exp && exp.days >= 0 && exp.days <= 7)) return false;
        if (expireFilter === 'set' && !exp) return false;
        if (kw && !`${r.name} ${r.user} ${r.target} ${r.note}`.toLowerCase().includes(kw)) return false;
        return true;
    });
}

function paintUnlock() {
    const box = root && root.querySelector('#ld-unlock');
    if (!box) return;
    const remain = unlockInfo.unlocked ? Math.max(0, Math.round((unlockInfo.until - Date.now()) / 1000)) : 0;
    box.innerHTML = unlockInfo.unlocked
        ? `<span class="badge green">已解锁</span><span class="muted" style="font-size:12px">剩 ${remain} 秒免口令</span>
           <button class="btn btn-ghost btn-sm" id="ld-lock">立即上锁</button>`
        : `<span class="badge gray">已锁定</span><span class="muted" style="font-size:12px">查看明文需登录口令；解锁后 5 分钟免重复输入</span>
           <button class="btn btn-ghost btn-sm" id="ld-unlock-btn">解锁</button>`;
    const lockBtn = box.querySelector('#ld-lock');
    if (lockBtn) lockBtn.addEventListener('click', async () => {
        await api.ledger.lock();
        unlockInfo = { unlocked: false, until: 0 };
        clearAllRevealed();
        paintUnlock();
        paint();
        toast('台账已上锁', 'info');
    });
    const unlockBtn = box.querySelector('#ld-unlock-btn');
    if (unlockBtn) unlockBtn.addEventListener('click', () => askPass('解锁台账', async pass => {
        const res = await api.ledger.unlock(pass);
        if (!res || !res.ok) throw new Error((res && res.message) || '解锁失败');
        unlockInfo = { unlocked: true, until: res.until };
        paintUnlock();
        toast('已解锁：5 分钟内查看明文免重复输入口令', 'success');
    }));
}

async function paint(tbodyEl) {
    const tbody = tbodyEl || root.querySelector('#ledger-tbody');
    const list = filteredRows();
    tbody.innerHTML = list.length ? list.map(rowHtml).join('') : emptyRow(8, rows.length ? '无匹配条目' : '暂无凭据');
    const expired = rows.filter(r => { const e = expireState(r); return e && e.days < 0; }).length;
    const soon = rows.filter(r => { const e = expireState(r); return e && e.days >= 0 && e.days <= 7; }).length;
    root.querySelector('#ledger-summary').textContent =
        `共 ${rows.length} 条凭据 · 已过期 ${expired} · 7 日内到期 ${soon} · 明文展示 ${revealed.size} 条（30 秒自动隐藏）`;
}

/* ---------------- 口令确认 / 解密 ---------------- */

/** 通用登录口令弹窗（解锁与单条查看共用）；回调抛错时保留弹窗显示错误 */
function askPass(title, onOk) {
    const mask = document.createElement('div');
    mask.className = 'modal-mask open';
    mask.innerHTML = `
    <div class="modal" style="width:400px">
        <div class="modal-header"><h3>${esc(title)}</h3><button class="modal-close" data-close>×</button></div>
        <div class="modal-body">
            <div class="alert info"><span>请输入<strong>当前登录账号的口令</strong>进行校验；操作会写入审计日志。</span></div>
            <div class="form-item" style="margin-top:12px">
                <input class="input" id="ld-pass" type="password" autocomplete="current-password" placeholder="登录口令">
            </div>
            <div class="form-hint" id="ld-pass-msg"></div>
        </div>
        <div class="modal-footer">
            <button class="btn btn-ghost" data-close>取消</button>
            <button class="btn btn-primary" id="ld-pass-ok">确认</button>
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
        btn.disabled = true; btn.textContent = '校验中...';
        try {
            await onOk(pass);
            close();
        } catch (err) {
            mask.querySelector('#ld-pass-msg').innerHTML = `<span class="text-danger">${esc(err.message || '校验失败')}</span>`;
        } finally {
            btn.disabled = false; btn.textContent = '确认';
        }
    };
    mask.querySelector('#ld-pass-ok').addEventListener('click', submit);
    input.addEventListener('keydown', e => { if (e.key === 'Enter') submit(); });
}

async function revealRow(row) {
    if (!guardAdmin('解密查看凭据')) return;
    const attempt = async pass => {
        const payload = { kind: row.kind, id: row.id };
        if (pass) payload.password = pass;
        const res = await api.ledger.reveal(payload);
        if (!res || !res.ok) {
            if (res && res.locked) { unlockInfo = { unlocked: false, until: 0 }; }
            throw new Error((res && res.message) || '解密失败');
        }
        const st = await api.ledger.status().catch(() => null);
        if (st && st.ok) unlockInfo = st;   // 主进程可能因本次校验自动续解锁
        paintUnlock();
        const timer = setTimeout(() => hideRow(row), AUTO_HIDE_MS);
        revealed.set(rowKey(row), { plain: res.password, timer });
        await paint();
        toast(`已显示「${row.name}」明文，30 秒后自动隐藏`, 'success');
    };
    try {
        await attempt(null);                     // 解锁态直接查看
    } catch (err) {
        if (unlockInfo.unlocked) { toast(err.message, 'danger'); return; }
        askPass('解密确认 · 首次输入后 5 分钟免口令', attempt);   // 锁定态：弹窗输口令
    }
}

function hideRow(row) {
    const hit = revealed.get(rowKey(row));
    if (hit) { clearTimeout(hit.timer); revealed.delete(rowKey(row)); }
    paint();
}

/* ---------------- 快速登记（Vault put 式） ---------------- */

const CHARSET = {
    lower: 'abcdefghijkmnopqrstuvwxyz',
    upper: 'ABCDEFGHJKLMNPQRSTUVWXYZ',
    digit: '23456789',
    symbol: '!@#$%^&*()-_=+'
};

function genPassword(len, sets) {
    const pool = sets.map(s => CHARSET[s]).join('');
    if (!pool) return '';
    const bytes = new Uint32Array(len);
    crypto.getRandomValues(bytes);
    return Array.from(bytes, b => pool[b % pool.length]).join('');
}

/** 粗略强度：字符集种类 × 长度熵 */
function strengthOf(pwd) {
    if (!pwd) return { score: 0, label: '—', cls: 'gray' };
    let pool = 0;
    if (/[a-z]/.test(pwd)) pool += 26;
    if (/[A-Z]/.test(pwd)) pool += 26;
    if (/[0-9]/.test(pwd)) pool += 10;
    if (/[^A-Za-z0-9]/.test(pwd)) pool += 20;
    const entropy = pwd.length * Math.log2(pool || 1);
    if (entropy >= 90) return { score: 4, label: '很强', cls: 'green' };
    if (entropy >= 65) return { score: 3, label: '强', cls: 'green' };
    if (entropy >= 45) return { score: 2, label: '中等', cls: 'amber' };
    return { score: 1, label: '弱', cls: 'red' };
}

function openQuickAdd() {
    if (!guardAdmin('登记凭据')) return;
    const mask = document.createElement('div');
    mask.className = 'modal-mask open';
    mask.innerHTML = `
    <div class="modal" style="width:460px">
        <div class="modal-header"><h3>快速登记凭据（业务系统）</h3><button class="modal-close" data-close>×</button></div>
        <div class="modal-body">
            <div class="form-item"><label>系统名称 *</label><input class="input" id="qa-name"></div>
            <div class="form-row">
                <div class="form-item"><label>地址</label><input class="input mono" id="qa-url" placeholder="https://..."></div>
                <div class="form-item"><label>账号</label><input class="input mono" id="qa-user"></div>
            </div>
            <div class="form-item">
                <label>口令</label>
                <div class="toolbar" style="margin:0;gap:6px">
                    <input class="input mono" id="qa-pass" type="text" style="flex:1" autocomplete="off">
                    <button class="btn btn-ghost btn-sm" id="qa-gen">随机生成</button>
                </div>
                <div style="display:flex;align-items:center;gap:8px;margin-top:6px">
                    <div class="strength-bar"><i id="qa-strength-fill"></i></div>
                    <span class="muted" id="qa-strength-text" style="font-size:12px">强度 —</span>
                    <span class="spacer"></span>
                    <label class="muted" style="font-size:12px">长度</label>
                    <input class="input" id="qa-len" type="number" min="6" max="64" value="16" style="width:64px">
                </div>
            </div>
            <div class="form-item"><label>有效期（可选，用于到期提醒）</label><input class="input" id="qa-expire" type="date"></div>
        </div>
        <div class="modal-footer">
            <button class="btn btn-ghost" data-close>取消</button>
            <button class="btn btn-primary" id="qa-save">登记入库（加密存储）</button>
        </div>
    </div>`;
    document.body.appendChild(mask);
    const $ = sel => mask.querySelector(sel);
    mask.querySelectorAll('[data-close]').forEach(el => el.addEventListener('click', () => mask.remove()));

    const paintStrength = () => {
        const s = strengthOf($('#qa-pass').value);
        $('#qa-strength-fill').style.width = `${s.score * 25}%`;
        $('#qa-strength-fill').className = s.cls;
        $('#qa-strength-text').textContent = `强度 ${s.label}`;
    };
    $('#qa-pass').addEventListener('input', paintStrength);
    $('#qa-gen').addEventListener('click', () => {
        const len = Math.min(64, Math.max(6, Number($('#qa-len').value) || 16));
        $('#qa-pass').value = genPassword(len, ['lower', 'upper', 'digit', 'symbol']);
        paintStrength();
    });

    $('#qa-save').addEventListener('click', async () => {
        const name = $('#qa-name').value.trim();
        const user = $('#qa-user').value.trim();
        if (!name || !user) { toast('系统名称与账号为必填', 'warn'); return; }
        const res = await api.accounts.save({
            name,
            url: $('#qa-url').value.trim(),
            user: $('#qa-user').value.trim(),
            password: $('#qa-pass').value,
            expiresAt: $('#qa-expire').value || '',
            status: 'ok'
        });
        if (res && res.ok) {
            toast('凭据已加密登记（可在台账与「多系统账号」页管理）', 'success');
            mask.remove();
            await load();
        } else toast((res && res.message) || '登记失败', 'danger');
    });
}

/* ---------------- 解密留痕 ---------------- */

async function loadRevealLog() {
    const box = root.querySelector('#ld-reveal-log');
    box.innerHTML = '<div class="empty">读取中...</div>';
    try {
        const res = await api.audit.query({ keyword: '台账', limit: 30 });
        const records = (res && res.records) || [];
        box.innerHTML = records.length
            ? `<div class="table-wrap" style="max-height:220px;overflow:auto"><table class="table"><tbody>
                ${records.slice(0, 20).map(r => `<tr>
                    <td class="muted" style="width:130px;font-size:12px">${esc(r.time || r.createdAt || '')}</td>
                    <td class="mono" style="width:80px">${esc(r.user || '-')}</td>
                    <td style="font-size:12px">${esc(r.detail || '')}</td>
                    <td style="width:60px">${r.result === 'failed' ? '<span class="badge red">失败</span>' : '<span class="badge gray">留痕</span>'}</td>
                </tr>`).join('')}
               </tbody></table></div>`
            : '<div class="empty">近期无台账相关审计记录</div>';
    } catch (err) {
        box.innerHTML = `<div class="empty">读取失败：${esc(err.message)}</div>`;
    }
}

/* ---------------- 视图 ---------------- */

export function render() {
    clearAllRevealed();
    return `
    ${demoBanner(demoMode)}
    <div class="card">
        <div class="card-header">
            <div>
                <div class="card-title">凭据台账</div>
                <div class="card-desc">业务系统 / 数据源 / 主机 SSH / Docker 端点统一台账 · AES-256-GCM 加密存储 · 仅系统管理员可解密查看</div>
            </div>
            <div class="toolbar" style="margin:0">
                <input class="input" id="ledger-search" placeholder="搜索名称 / 账号 / 地址" style="width:190px">
                <button class="btn btn-ghost btn-sm" id="ledger-refresh">刷新</button>
                <button class="btn btn-primary btn-sm" data-write id="ledger-quick-add">+ 快速登记</button>
            </div>
        </div>
        <div class="ledger-bar">
            <span id="ld-unlock" class="ledger-unlock"></span>
            <div class="spacer"></div>
            <select class="select" id="ledger-expire-filter" style="width:150px;height:30px;font-size:12.5px">
                <option value="all">到期状态：全部</option>
                <option value="expired">已过期</option>
                <option value="soon">7 日内到期</option>
                <option value="set">设置了有效期</option>
            </select>
        </div>
        <div class="tabs" id="ledger-tabs">
            ${KIND_FILTERS.map(f => `<div class="tab ${f.id === filter ? 'active' : ''}" data-kind="${f.id}">${f.label}</div>`).join('')}
        </div>
        <div class="table-wrap">
            <table class="table">
                <thead><tr>
                    <th>类型</th><th>名称</th><th>地址</th><th>账号</th><th>口令</th><th>有效期</th><th>备注</th><th>操作</th>
                </tr></thead>
                <tbody id="ledger-tbody">${loadingRow(8)}</tbody>
            </table>
        </div>
        <div class="form-hint" id="ledger-summary"></div>
    </div>

    <div class="card">
        <div class="card-header">
            <div>
                <div class="card-title">解密留痕</div>
                <div class="card-desc">解锁 / 查看明文 / 校验失败均记录于审计日志（点「刷新」重新拉取）</div>
            </div>
            <button class="btn btn-ghost btn-sm" id="ld-log-refresh">刷新</button>
        </div>
        <div id="ld-reveal-log"><div class="empty">展开后加载</div></div>
    </div>`;
}

async function load() {
    const tbody = root.querySelector('#ledger-tbody');
    tbody.innerHTML = loadingRow(8);
    try {
        const res = await api.ledger.list();
        rows = Array.isArray(res) ? res : [];
    } catch (err) {
        rows = [];
        toast('台账加载失败：' + err.message, 'danger');
    }
    await paint(tbody);
}

export async function mount(r) {
    root = r;
    if (unlockTimer) clearInterval(unlockTimer);

    try {
        const statusRes = await api.ledger.status();
        if (statusRes && statusRes.ok) unlockInfo = statusRes;
    } catch (err) { /* 演示模式兜底 */ }
    paintUnlock();
    unlockTimer = setInterval(paintUnlock, UNLOCK_POLL_MS);

    loadRevealLog();

    root.querySelector('#ledger-refresh').addEventListener('click', async () => {
        clearAllRevealed();
        await load();
        await loadRevealLog();
    });
    root.querySelector('#ld-log-refresh').addEventListener('click', loadRevealLog);
    root.querySelector('#ledger-quick-add').addEventListener('click', openQuickAdd);
    root.querySelector('#ledger-search').addEventListener('input', e => { keyword = e.target.value; paint(); });
    root.querySelector('#ledger-expire-filter').addEventListener('change', e => { expireFilter = e.target.value; paint(); });
    root.querySelector('#ledger-tabs').addEventListener('click', e => {
        const tab = e.target.closest('.tab');
        if (!tab) return;
        filter = tab.dataset.kind;
        root.querySelectorAll('#ledger-tabs .tab').forEach(t => t.classList.toggle('active', t === tab));
        paint();
    });

    root.querySelector('#ledger-tbody').addEventListener('click', e => {
        const btn = e.target.closest('[data-act]');
        if (!btn) return;
        const key = `${btn.dataset.kind}:${btn.dataset.id}`;
        const row = rows.find(r => rowKey(r) === key);
        if (!row) return;
        if (btn.dataset.act === 'copy') {
            const hit = revealed.get(key);
            if (hit) copyText(hit.plain);
            return;
        }
        if (btn.dataset.act === 'reveal') {
            if (revealed.has(key)) { hideRow(row); return; }
            revealRow(row);
        }
    });
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
