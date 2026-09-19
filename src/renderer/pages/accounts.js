/**
 * 多系统账号页
 * 数据流：accounts:list（密码永不明文下发）
 *   accounts:reveal（查看明文，必留痕） / accounts:loginTest（模拟登录）
 *   accounts:reset（一键重置密码，由绑定 Python 脚本执行） / accounts:policy:save
 */
import { api, demoMode } from '../api.js';
import { esc, toast, demoBanner, emptyRow, loadingRow, applyReadonly } from '../ui.js';

let accounts = [];
let policy = null;
let editingId = null;

const statusBadge = s =>
    s === 'ok' ? '<span class="badge green">凭据有效</span>'
    : s === 'expired' ? '<span class="badge amber">密码待更新</span>'
    : '<span class="badge red">异常</span>';

function rowHtml(a) {
    return `
    <tr data-id="${esc(a.id)}">
        <td><strong>${esc(a.name)}</strong></td>
        <td class="mono muted">${esc(a.url)}</td>
        <td class="mono">${esc(a.user)}</td>
        <td><span class="mono pwd-cell">${a.passwordMasked || '●●●●●●●●'}</span>
            <button class="btn-link" data-act="reveal" data-write>显示</button></td>
        <td><span class="badge purple">${esc(a.scriptName || '未绑定')}</span></td>
        <td>${statusBadge(a.status)}</td>
        <td class="muted">${esc(a.lastSyncAt || '-')}</td>
        <td style="white-space:nowrap">
            <button class="btn-link" data-act="reset" data-write>一键重置密码</button>
            <button class="btn-link" data-act="login" data-write>登录测试</button>
            <button class="btn-link" data-act="edit" data-write>编辑</button>
            <button class="btn-link danger" data-act="delete" data-write>删除</button>
        </td>
    </tr>`;
}

export function render() {
    return `
    ${demoBanner(demoMode)}
    <div class="alert info">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="11" width="18" height="10" rx="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/></svg>
        <span>账号密码使用 AES-256-GCM 加密存储于本地库，界面与 IPC 均不下发明文；查看明文、重置密码、模拟登录等操作全部写入审计日志。</span>
    </div>

    <div class="card">
        <div class="toolbar">
            <input class="input" id="acc-search" placeholder="搜索系统名称 / 账号..." style="width:220px">
            <button class="btn btn-ghost btn-sm" id="btn-refresh-acc">刷新</button>
            <div class="spacer"></div>
            <button class="btn btn-primary" id="btn-add-acc" data-write>+ 接入新系统</button>
        </div>
        <div class="table-wrap">
            <table class="table">
                <thead><tr><th>业务系统</th><th>地址</th><th>账号</th><th>密码</th><th>绑定脚本</th><th>凭据状态</th><th>最近同步</th><th>操作</th></tr></thead>
                <tbody id="acc-tbody">${loadingRow(8)}</tbody>
            </table>
        </div>
    </div>

    <div class="card">
        <div class="card-header">
            <div>
                <div class="card-title">重置密码策略</div>
                <div class="card-desc">「一键重置密码」时按此策略生成新密码，并通过绑定脚本登录目标系统使其生效</div>
            </div>
        </div>
        <div class="form-row">
            <div class="form-item">
                <label>密码长度</label>
                <select class="select" id="p-length" style="width:100%">
                    <option value="12">12 位</option>
                    <option value="16">16 位（推荐）</option>
                    <option value="20">20 位</option>
                </select>
            </div>
            <div class="form-item">
                <label>字符集</label>
                <select class="select" id="p-charset" style="width:100%">
                    <option value="full">大小写 + 数字 + 特殊字符</option>
                    <option value="alnum">大小写 + 数字</option>
                </select>
            </div>
            <div class="form-item">
                <label>重置后动作</label>
                <select class="select" id="p-after" style="width:100%">
                    <option value="verify">回写加密库 + 登录验证</option>
                    <option value="store">仅回写加密库</option>
                </select>
            </div>
        </div>
        <div class="toolbar" style="margin-top:16px;justify-content:flex-end">
            <button class="btn btn-primary" id="btn-save-policy" data-write>保存策略</button>
        </div>
    </div>

    <div class="modal-mask" id="acc-modal">
        <div class="modal">
            <div class="modal-header">
                <h3 id="acc-modal-title">接入新系统</h3>
                <button class="modal-close" data-close>×</button>
            </div>
            <div class="modal-body">
                <div class="form-row">
                    <div class="form-item">
                        <label>系统名称</label>
                        <input class="input" id="a-name" placeholder="堡垒机系统">
                    </div>
                    <div class="form-item">
                        <label>系统地址</label>
                        <input class="input mono" id="a-url" placeholder="https://bastion.corp.local">
                    </div>
                </div>
                <div class="form-row">
                    <div class="form-item">
                        <label>登录账号</label>
                        <input class="input mono" id="a-user" placeholder="svc_ops">
                    </div>
                    <div class="form-item">
                        <label>登录密码</label>
                        <input class="input" id="a-password" type="password" placeholder="留空表示不修改">
                    </div>
                    <div class="form-item" style="flex:0 0 160px">
                        <label>有效期（可选）</label>
                        <input class="input" id="a-expires" type="date">
                        <div class="form-hint">用于台账到期提醒</div>
                    </div>
                </div>
                <div class="form-item">
                    <label>绑定 Python 脚本</label>
                    <select class="select" id="a-script" style="width:100%"></select>
                    <div class="form-hint">脚本通过环境变量 SYS_URL / SYS_USER / NEW_PASSWORD 获取上下文，实现模拟登录与密码重置</div>
                </div>
            </div>
            <div class="modal-footer">
                <button class="btn btn-ghost" data-close>取消</button>
                <button class="btn btn-primary" id="acc-save">保存</button>
            </div>
        </div>
    </div>`;
}

export async function mount(root) {
    const tbody = root.querySelector('#acc-tbody');
    const modal = root.querySelector('#acc-modal');

    const refresh = async () => {
        try {
            accounts = await api.accounts.list();
            tbody.innerHTML = accounts.length ? accounts.map(rowHtml).join('') : emptyRow(8, '暂无接入的系统');
        } catch (err) {
            tbody.innerHTML = emptyRow(8, '账号加载失败：' + err.message);
        }
    };

    // 策略加载
    try {
        const config = await api.system.getConfig();
        policy = (config && config.resetPolicy) || { length: 16, charset: 'full', afterReset: 'verify' };
        root.querySelector('#p-length').value = String(policy.length || 16);
        root.querySelector('#p-charset').value = policy.charset || 'full';
        root.querySelector('#p-after').value = policy.afterReset || 'verify';
    } catch (err) { /* 使用默认策略 */ }

    root.querySelector('#btn-save-policy').addEventListener('click', async () => {
        const res = await api.accounts.savePolicy({
            length: parseInt(root.querySelector('#p-length').value, 10),
            charset: root.querySelector('#p-charset').value,
            afterReset: root.querySelector('#p-after').value
        });
        toast(res && res.ok ? '策略已保存' : '保存失败', res && res.ok ? 'success' : 'danger');
    });

    const openModal = async (acc) => {
        editingId = acc ? acc.id : null;
        root.querySelector('#acc-modal-title').textContent = acc ? `编辑 · ${acc.name}` : '接入新系统';
        root.querySelector('#a-name').value = acc ? acc.name : '';
        root.querySelector('#a-url').value = acc ? acc.url : '';
        root.querySelector('#a-user').value = acc ? acc.user : '';
        root.querySelector('#a-password').value = '';
        root.querySelector('#a-expires').value = acc ? (acc.expiresAt || '') : '';
        let scripts = [];
        try { scripts = await api.scripts.list(); } catch (err) { /* 忽略 */ }
        const pythonScripts = scripts.filter(s => s.type === 'python');
        root.querySelector('#a-script').innerHTML = pythonScripts.length
            ? pythonScripts.map(s => `<option value="${esc(s.name)}" ${acc && acc.scriptName === s.name ? 'selected' : ''}>${esc(s.name)}</option>`).join('')
            : '<option value="">（暂无 Python 脚本，请先在脚本管理中托管）</option>';
        modal.classList.add('open');
    };

    root.querySelector('#btn-add-acc').addEventListener('click', () => openModal(null));

    root.querySelector('#btn-refresh-acc').addEventListener('click', refresh);
    modal.querySelectorAll('[data-close]').forEach(el => el.addEventListener('click', () => modal.classList.remove('open')));

    root.querySelector('#acc-search').addEventListener('input', e => {
        const kw = e.target.value.trim().toLowerCase();
        [...tbody.rows].forEach(tr => {
            tr.style.display = tr.textContent.toLowerCase().includes(kw) ? '' : 'none';
        });
    });

    root.querySelector('#acc-save').addEventListener('click', async () => {
        const payload = {
            id: editingId || undefined,
            name: root.querySelector('#a-name').value.trim(),
            url: root.querySelector('#a-url').value.trim(),
            user: root.querySelector('#a-user').value.trim(),
            scriptName: root.querySelector('#a-script').value,
            password: root.querySelector('#a-password').value,
            expiresAt: root.querySelector('#a-expires').value || '',
            status: 'ok'
        };
        if (!payload.name || !payload.url || !payload.user) { toast('系统名称、地址、账号均为必填', 'warn'); return; }
        const res = await api.accounts.save(payload);
        if (res && res.ok) {
            toast('已保存（密码已加密存储）', 'success');
            modal.classList.remove('open');
            await refresh();
        } else {
            toast((res && res.message) || '保存失败', 'danger');
        }
    });

    // 行内操作
    tbody.addEventListener('click', async e => {
        const btn = e.target.closest('[data-act]');
        if (!btn) return;
        const row = btn.closest('tr');
        const id = row.dataset.id;
        const acc = accounts.find(a => a.id === id);
        const act = btn.dataset.act;

        if (act === 'reveal') {
            const cell = row.querySelector('.pwd-cell');
            if (btn.textContent === '隐藏') {
                cell.textContent = acc.passwordMasked || '●●●●●●●●';
                btn.textContent = '显示';
                return;
            }
            if (!confirm(`查看「${acc.name}」的明文密码？该操作将记入审计日志。`)) return;
            const res = await api.accounts.reveal(id);
            if (res && res.ok) {
                cell.textContent = res.password || '（未设置）';
                btn.textContent = '隐藏';
                toast('明文密码已显示，操作已留痕', 'warn');
            } else {
                toast((res && res.message) || '读取失败', 'danger');
            }
        } else if (act === 'reset') {
            if (!confirm(`将对「${acc.name}」执行模拟登录并重置密码？\n（由脚本 ${acc.scriptName} 在本机执行，全程留痕）`)) return;
            btn.textContent = '重置中...';
            btn.disabled = true;
            const res = await api.accounts.reset(id);
            btn.disabled = false;
            btn.textContent = '一键重置密码';
            toast(res && res.ok ? `重置成功：${res.message}` : `重置失败：${(res && res.message) || '未知错误'}`,
                res && res.ok ? 'success' : 'danger');
            await refresh();
        } else if (act === 'login') {
            btn.textContent = '登录中...';
            btn.disabled = true;
            const res = await api.accounts.loginTest(id);
            btn.disabled = false;
            btn.textContent = '登录测试';
            toast(`模拟登录${res && res.ok ? '成功' : '失败'}：${(res && res.message) || ''}`,
                res && res.ok ? 'success' : 'danger');
            await refresh();
        } else if (act === 'edit') {
            await openModal(acc);
        } else if (act === 'delete') {
            if (!confirm(`确认移除业务系统「${acc.name}」及其加密凭据？`)) return;
            const res = await api.accounts.remove(id);
            if (res && res.ok) { toast('已移除', 'success'); await refresh(); }
            else toast('移除失败', 'danger');
        }
    });

    await refresh();
    applyReadonly(root);
}
