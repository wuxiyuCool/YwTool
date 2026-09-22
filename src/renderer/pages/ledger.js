/**
 * 系统运维 · 凭据台账（凭证中心，仅系统管理员）
 * 数据流：ledger:list（聚合掩码列表）· ledger:unlock|lock|status（Vault 式解锁会话）
 *        ledger:reveal（解锁期内免口令解密，锁定态强制登录口令二次校验）· audit:query（解密留痕）
 *        新增登记走各来源模块通道（accounts/dbconfig/hosts/docker:host:save），与源模块实时联动
 *        备份与迁移（system:backup:*）与外置密钥（system:secrets:*）自原「备份与密钥」页并入
 *
 * Vault 参考的实用化设计：
 *   - 解锁会话：口令校验一次 → 5 分钟 TTL 内查看其它条目免重复输入，到期自动回锁（可手动上锁）
 *   - 到期治理：业务系统凭据支持 expiresAt，列表给出「已过期 / 即将到期」徽标与筛选
 *   - 快速登记：支持业务系统 / 数据源 / 主机 / Docker 端点四类，生成强随机口令（带强度计）
 *   - 快捷搜索：Ctrl+F 或 / 聚焦，跨名称/账号/地址/备注即时过滤
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
/** 快速登记支持的类型 → 来源模块保存通道（与源模块数据同源，天然联动） */
const ADD_KINDS = [
    { id: 'account', label: '业务系统账号', api: 'accounts' },
    { id: 'db', label: '数据库数据源', api: 'db' },
    { id: 'host', label: 'SSH 主机', api: 'host' },
    { id: 'docker', label: 'Docker 端点', api: 'docker' }
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
/** 文档级快捷键监听（重复 mount 时先摘掉旧的） */
let hotkeyHandler = null;

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
    const shown = list.length !== rows.length ? ` · 筛选出 ${list.length} 条` : '';
    root.querySelector('#ledger-summary').textContent =
        `共 ${rows.length} 条凭据${shown} · 已过期 ${expired} · 7 日内到期 ${soon} · 明文展示 ${revealed.size} 条（30 秒自动隐藏）`;
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

/* ---------------- 快速登记（多类型，写回来源模块） ---------------- */

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

/** 各类型的专属字段（名称/账号/口令为公共字段） */
const ADD_FIELDS = {
    account: [
        { id: 'url', label: '地址', placeholder: 'https://...' },
        { id: 'expiresAt', label: '有效期（可选，到期提醒）', type: 'date' }
    ],
    db: [
        { id: 'type', label: '数据库类型', type: 'select', options: [['mysql', 'MySQL'], ['oracle', 'Oracle'], ['postgres', 'PostgreSQL']] },
        { id: 'host', label: '主机', placeholder: '10.0.0.1' },
        { id: 'port', label: '端口', placeholder: '1521' },
        { id: 'database', label: '库名/SID', placeholder: 'orcl' }
    ],
    host: [
        { id: 'ip', label: 'IP 地址 *', placeholder: '10.0.12.11' },
        { id: 'port', label: 'SSH 端口', placeholder: '22' }
    ],
    docker: [
        { id: 'kind', label: '连接方式', type: 'select', options: [['pipe', '本机 socket'], ['tcp', 'TCP（需 token）']] },
        { id: 'host', label: 'TCP 主机', placeholder: 'kind=tcp 时填写' },
        { id: 'port', label: 'TCP 端口', placeholder: '2375' }
    ]
};

function openQuickAdd(presetKind) {
    if (!guardAdmin('登记凭据')) return;
    const mask = document.createElement('div');
    mask.className = 'modal-mask open';
    const kindOptions = ADD_KINDS.map(k =>
        `<option value="${k.id}"${k.id === presetKind ? ' selected' : ''}>${k.label}</option>`).join('');
    mask.innerHTML = `
    <div class="modal" style="width:520px">
        <div class="modal-header"><h3>登记凭据（写回来源模块）</h3><button class="modal-close" data-close>×</button></div>
        <div class="modal-body">
            <div class="form-row">
                <div class="form-item"><label>凭据类型 *</label><select class="select" id="qa-kind" style="width:100%">${kindOptions}</select></div>
                <div class="form-item"><label>名称 *</label><input class="input" id="qa-name" placeholder="如：堡垒机 / 生产库 / app-server-01"></div>
            </div>
            <div id="qa-extra"></div>
            <div class="form-row">
                <div class="form-item"><label>账号 / Token 名</label><input class="input mono" id="qa-user"></div>
                <div class="form-item" id="qa-pass-wrap"><label>口令 / Token *</label>
                    <div class="toolbar" style="margin:0;gap:6px">
                        <input class="input mono" id="qa-pass" type="text" style="flex:1" autocomplete="off">
                        <button class="btn btn-ghost btn-sm" id="qa-gen">随机生成</button>
                    </div>
                </div>
            </div>
            <div style="display:flex;align-items:center;gap:8px;margin-bottom:12px">
                <div class="strength-bar"><i id="qa-strength-fill"></i></div>
                <span class="muted" id="qa-strength-text" style="font-size:12px">强度 —</span>
                <span class="spacer"></span>
                <label class="muted" style="font-size:12px">长度</label>
                <input class="input" id="qa-len" type="number" min="6" max="64" value="16" style="width:64px">
            </div>
            <div class="form-hint">保存后条目即出现在对应管理模块（主机管理 / 数据库配置 / 容器运维 / 多系统账号），台账与源模块实时同步。</div>
        </div>
        <div class="modal-footer">
            <button class="btn btn-ghost" data-close>取消</button>
            <button class="btn btn-primary" id="qa-save">登记入库（加密存储）</button>
        </div>
    </div>`;
    document.body.appendChild(mask);
    const $ = sel => mask.querySelector(sel);
    mask.querySelectorAll('[data-close]').forEach(el => el.addEventListener('click', () => mask.remove()));

    const paintExtra = () => {
        const kind = $('#qa-kind').value;
        $('#qa-extra').innerHTML = `<div class="form-row">${(ADD_FIELDS[kind] || []).map(f => {
            if (f.type === 'select') {
                return `<div class="form-item"><label>${esc(f.label)}</label><select class="select" id="qa-${f.id}" style="width:100%">
                    ${f.options.map(o => `<option value="${esc(o[0])}">${esc(o[1])}</option>`).join('')}</select></div>`;
            }
            return `<div class="form-item"><label>${esc(f.label)}</label><input class="input${f.type === 'date' ? '' : ' mono'}" id="qa-${f.id}" type="${f.type || 'text'}" placeholder="${esc(f.placeholder || '')}"></div>`;
        }).join('')}</div>`;
    };
    paintExtra();
    $('#qa-kind').addEventListener('change', paintExtra);

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
        const kind = $('#qa-kind').value;
        const name = $('#qa-name').value.trim();
        const user = $('#qa-user').value.trim();
        const pass = $('#qa-pass').value;
        if (!name) { toast('请填写名称', 'warn'); return; }
        const val = id => { const el = $(`#qa-${id}`); return el ? el.value.trim() : ''; };
        let res;
        if (kind === 'account') {
            if (!user) { toast('账号为必填', 'warn'); return; }
            res = await api.accounts.save({ name, url: val('url'), user, password: pass, expiresAt: val('expiresAt'), status: 'ok' });
        } else if (kind === 'db') {
            res = await api.dbConfig.save({ name, type: val('type') || 'oracle', host: val('host'), port: Number(val('port')) || undefined,
                database: val('database'), user, password: pass, enabled: true });
        } else if (kind === 'host') {
            if (!val('ip')) { toast('IP 地址为必填', 'warn'); return; }
            res = await api.hosts.save({ name, ip: val('ip'), port: Number(val('port')) || 22, user: user || 'root',
                authType: 'password', password: pass, tags: [] });
        } else {
            const dk = val('kind') || 'pipe';
            res = await api.docker.hosts.save({ name, kind: dk, host: dk === 'tcp' ? val('host') : '', port: dk === 'tcp' ? (Number(val('port')) || 2375) : '',
                pipePath: '', hostId: '', token: pass, tags: [], status: 'unknown' });
        }
        if (res && res.ok !== false) {
            toast(`凭据已加密登记到「${(ADD_KINDS.find(k => k.id === kind) || {}).label}」，台账与源模块已同步`, 'success');
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

/* ---------------- 备份与外置密钥（自原「备份与密钥」页并入） ---------------- */

async function refreshSecrets() {
    const badge = root.querySelector('#sk-state');
    const fileEl = root.querySelector('#sk-file');
    try {
        const s = await api.system.secrets.status();
        if (!s || !s.ok) { badge.textContent = '不可用'; badge.className = 'badge gray'; return; }
        fileEl.value = s.file || '';
        root.querySelector('#sk-autosync').checked = s.autoSync !== false;
        if (s.error) {
            badge.textContent = '解析错误'; badge.className = 'badge red';
        } else if (s.exists && s.count > 0) {
            badge.textContent = `已注入 ${s.count} 项` + (s.aiKeys && s.aiKeys.length ? ' · 含 AI' : '');
            badge.className = 'badge green';
        } else if (s.exists) {
            badge.textContent = '文件存在（未填值）'; badge.className = 'badge amber';
        } else {
            badge.textContent = '未启用'; badge.className = 'badge gray';
        }
    } catch (err) {
        badge.textContent = '查询失败'; badge.className = 'badge red';
    }
}

function bindBackupSection() {
    root.querySelector('#btn-bk-export').addEventListener('click', async () => {
        if (!guardAdmin('导出配置备份')) return;
        const pass = root.querySelector('#bk-export-pass').value;
        const pass2 = root.querySelector('#bk-export-pass2').value;
        const msg = root.querySelector('#bk-export-msg');
        if (pass.length < 8) { toast('备份口令至少 8 位', 'warn'); return; }
        if (pass !== pass2) { toast('两次输入的口令不一致', 'warn'); return; }
        msg.textContent = '加密导出中...';
        const res = await api.system.backup.export({
            passphrase: pass,
            includeUsers: root.querySelector('#bk-include-users').checked,
            includeHistory: root.querySelector('#bk-include-history').checked
        });
        if (res && res.ok) {
            msg.textContent = `已导出：${res.filePath}`;
            toast('备份文件已加密导出', 'success');
        } else if (res && !res.canceled) {
            msg.textContent = '';
            toast((res && res.message) || '导出失败', 'danger');
        } else {
            msg.textContent = '';
        }
    });

    root.querySelector('#btn-bk-import').addEventListener('click', async () => {
        if (!guardAdmin('导入配置备份')) return;
        const pass = root.querySelector('#bk-import-pass').value;
        const mode = root.querySelector('#bk-import-mode').value;
        const msg = root.querySelector('#bk-import-msg');
        if (!pass) { toast('请输入备份口令', 'warn'); return; }
        if (mode === 'replace' && !confirm('「替换」模式将整体覆盖同名配置集合，确认继续？')) return;
        msg.textContent = '解密校验中...';
        const res = await api.system.backup.import({ passphrase: pass, mode });
        if (res && res.ok) {
            const total = Object.values(res.counts || {}).reduce((a, b) => a + b, 0);
            msg.textContent = `已导入 ${total} 条（备份生成于 ${res.createdAt || '-'}）`;
            toast('备份导入完成，正在刷新台账', 'success');
            root.querySelector('#bk-import-pass').value = '';
            await load();
        } else if (res && !res.canceled) {
            msg.textContent = '';
            toast((res && res.message) || '导入失败', 'danger');
        } else {
            msg.textContent = '';
        }
    });

    root.querySelector('#btn-sk-refresh').addEventListener('click', refreshSecrets);
    root.querySelector('#sk-autosync').addEventListener('change', async e => {
        if (!guardAdmin('切换自动同步')) { e.target.checked = !e.target.checked; return; }
        const res = await api.system.saveConfig({ secretsAutoSync: e.target.checked });
        if (res && res.ok) toast(e.target.checked ? '已开启凭据自动同步' : '已关闭自动同步', 'success');
        else { e.target.checked = !e.target.checked; toast('保存失败', 'danger'); }
    });
    root.querySelector('#btn-sk-template').addEventListener('click', async () => {
        if (!guardAdmin('生成外置密钥模板')) return;
        const msg = root.querySelector('#sk-msg');
        msg.textContent = '生成中...';
        const res = await api.system.secrets.template();
        if (res && res.ok) {
            msg.textContent = res.created ? `已创建：${res.file}` : (res.message || '文件已存在');
            toast(res.created ? '模板已生成，编辑该文件注入密钥' : '文件已存在，未覆盖', res.created ? 'success' : 'info');
            await refreshSecrets();
        } else {
            msg.textContent = '';
            toast((res && res.message) || '生成失败', 'danger');
        }
    });
    root.querySelector('#btn-sk-encrypt').addEventListener('click', async () => {
        if (!guardAdmin('加密外置密钥')) return;
        const plain = root.querySelector('#sk-plain').value;
        if (!plain) { toast('请输入要加密的内容', 'warn'); return; }
        const res = await api.system.secrets.encrypt(plain);
        if (res && res.ok) {
            root.querySelector('#sk-cipher').value = res.cipher;
            root.querySelector('#sk-plain').value = '';
            toast('已生成密文，粘贴到外置文件对应键即可', 'success');
        } else {
            toast((res && res.message) || '加密失败', 'danger');
        }
    });
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
                <div class="card-desc">业务系统 / 数据源 / 主机 SSH / Docker 端点统一台账，与源模块实时联动 · AES-256-GCM 加密存储 · 仅系统管理员可解密查看</div>
            </div>
            <div class="toolbar" style="margin:0">
                <input class="input" id="ledger-search" placeholder="快捷搜索 名称/账号/地址（Ctrl+F）" style="width:230px">
                <button class="btn btn-ghost btn-sm" id="ledger-refresh">刷新</button>
                <button class="btn btn-primary btn-sm" data-write id="ledger-quick-add">+ 登记凭据</button>
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

    <div class="grid-2">
        <div class="card">
            <div class="card-header">
                <div>
                    <div class="card-title">备份与迁移</div>
                    <div class="card-desc">全量配置（含台账凭据密文）导出为口令加密文件 · scrypt + AES-256-GCM</div>
                </div>
            </div>
            <div class="form-item">
                <label>备份口令（至少 8 位）</label>
                <input class="input" type="password" id="bk-export-pass" autocomplete="new-password" placeholder="用于加密备份文件，导入时需要输入">
            </div>
            <div class="form-item">
                <label>确认口令</label>
                <input class="input" type="password" id="bk-export-pass2" autocomplete="new-password">
            </div>
            <label class="check-item"><input type="checkbox" id="bk-include-users" checked>
                <div><strong>包含用户与权限矩阵</strong><span class="muted" style="font-size:11.5px">登录口令为 scrypt 哈希，可跨机恢复</span></div>
            </label>
            <label class="check-item"><input type="checkbox" id="bk-include-history">
                <div><strong>包含执行历史</strong><span class="muted" style="font-size:11.5px">任务 / SQL / ETL 记录与告警（体积较大，默认不含）</span></div>
            </label>
            <div class="toolbar" style="margin-top:12px">
                <button class="btn btn-primary btn-sm" data-write id="btn-bk-export">导出备份…</button>
                <span class="muted" id="bk-export-msg" style="font-size:12px"></span>
            </div>
            <div class="form-item" style="margin-top:12px">
                <label>导入：备份口令</label>
                <input class="input" type="password" id="bk-import-pass" autocomplete="off" placeholder="输入导出时设置的口令">
            </div>
            <div class="form-item">
                <label>导入模式</label>
                <select class="select" id="bk-import-mode" style="width:100%">
                    <option value="merge">合并（同 id 覆盖，其余追加）</option>
                    <option value="replace">替换（集合整体覆盖）</option>
                </select>
                <div class="form-hint">导入前自动保留当前库快照（.pre-import-*）；「替换」会覆盖同名集合，执行前请确认</div>
            </div>
            <div class="toolbar" style="margin-top:12px">
                <button class="btn btn-danger btn-sm" data-write id="btn-bk-import">选择备份文件并导入…</button>
                <span class="muted" id="bk-import-msg" style="font-size:12px"></span>
            </div>
        </div>

        <div class="card">
            <div class="card-header">
                <div>
                    <div class="card-title">外置密钥配置</div>
                    <div class="card-desc">敏感数据由 gitignore 外置文件注入（配置外挂），修改后自动生效无需重启</div>
                </div>
                <span class="badge gray" id="sk-state">检查中</span>
            </div>
            <div class="form-item">
                <label>当前生效文件</label>
                <input class="input mono" id="sk-file" readonly placeholder="—">
                <div class="form-hint">查找顺序：SGOPS_SECRETS_FILE 环境变量 → exe 同目录 sgops.secrets.json → 数据目录；键格式：db:源ID / host:主机ID / docker:端点ID / ledger:条目ID / acc:账号ID</div>
            </div>
            <label class="check-item" style="margin-bottom:12px">
                <input type="checkbox" id="sk-autosync">
                <div><strong>自动同步</strong><span class="muted" style="font-size:11.5px">应用内保存/删除凭据时自动写入或移除外置文件对应键（v1: 本机密文）</span></div>
            </label>
            <div class="toolbar">
                <button class="btn btn-ghost btn-sm" data-write id="btn-sk-refresh">刷新状态</button>
                <button class="btn btn-primary btn-sm" data-write id="btn-sk-template">生成模板文件</button>
                <span class="muted" id="sk-msg" style="font-size:12px"></span>
            </div>
            <div class="form-item" style="margin-top:10px">
                <label>加密工具（明文 → v1: 本机密文）</label>
                <div class="toolbar" style="margin:0">
                    <input class="input" id="sk-plain" type="password" placeholder="输入要加密的密钥/口令" style="max-width:320px">
                    <button class="btn btn-ghost btn-sm" data-write id="btn-sk-encrypt">加密</button>
                </div>
                <textarea class="textarea mono" id="sk-cipher" rows="2" readonly placeholder="生成的 v1:... 密文（仅本机可解密）" style="margin-top:8px;font-size:11.5px"></textarea>
            </div>
        </div>
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
    if (hotkeyHandler) document.removeEventListener('keydown', hotkeyHandler);

    try {
        const statusRes = await api.ledger.status();
        if (statusRes && statusRes.ok) unlockInfo = statusRes;
    } catch (err) { /* 演示模式兜底 */ }
    paintUnlock();
    unlockTimer = setInterval(paintUnlock, UNLOCK_POLL_MS);

    loadRevealLog();
    bindBackupSection();
    refreshSecrets();

    root.querySelector('#ledger-refresh').addEventListener('click', async () => {
        clearAllRevealed();
        await load();
        await loadRevealLog();
    });
    root.querySelector('#ld-log-refresh').addEventListener('click', loadRevealLog);
    root.querySelector('#ledger-quick-add').addEventListener('click', () => openQuickAdd('account'));
    root.querySelector('#ledger-search').addEventListener('input', e => { keyword = e.target.value; paint(); });
    root.querySelector('#ledger-expire-filter').addEventListener('change', e => { expireFilter = e.target.value; paint(); });
    root.querySelector('#ledger-tabs').addEventListener('click', e => {
        const tab = e.target.closest('.tab');
        if (!tab) return;
        filter = tab.dataset.kind;
        root.querySelectorAll('#ledger-tabs .tab').forEach(t => t.classList.toggle('active', t === tab));
        paint();
    });

    // 快捷搜索：Ctrl+F 或 / 聚焦搜索框（输入态除外）
    hotkeyHandler = e => {
        if (!document.contains(root)) return;
        const tag = (document.activeElement || {}).tagName;
        const typing = tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT';
        const hit = (e.ctrlKey && e.key === 'f') || (e.key === '/' && !typing);
        if (!hit) return;
        const input = root.querySelector('#ledger-search');
        if (!input) return;
        e.preventDefault();
        input.focus();
        input.select();
    };
    document.addEventListener('keydown', hotkeyHandler);

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

    await load();
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
