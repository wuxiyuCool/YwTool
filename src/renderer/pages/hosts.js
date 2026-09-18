/**
 * 主机管理页
 * 数据流：hosts:list（列表） / hosts:save（新增·编辑） / hosts:delete / hosts:test（SSH 连接测试）
 */
import { api, demoMode } from '../api.js';
import { esc, toast, demoBanner, emptyRow, loadingRow, shortTime, applyReadonly } from '../ui.js';

let hosts = [];
let editingId = null;
let keyword = '';

const statusBadge = s =>
    s === 'online' ? '<span class="badge green">在线</span>'
    : s === 'offline' ? '<span class="badge red">离线</span>'
    : '<span class="badge gray">未探测</span>';

function rowHtml(h) {
    return `
    <tr data-id="${esc(h.id)}">
        <td><input type="checkbox" class="row-check" style="accent-color:var(--primary)"></td>
        <td><strong>${esc(h.name)}</strong></td>
        <td class="mono">${esc(h.ip)}:${esc(h.port)}</td>
        <td>${esc(h.user)}</td>
        <td>${h.authType === 'password' ? '<span class="badge gray">密码</span>' : '<span class="badge blue">密钥</span>'}</td>
        <td>${(h.tags || []).map(t => `<span class="badge gray">${esc(t)}</span>`).join(' ')}</td>
        <td class="status-cell">${statusBadge(h.status)}</td>
        <td class="muted">${esc(shortTime(h.lastConnectedAt))}</td>
        <td style="white-space:nowrap">
            <button class="btn-link" data-act="test" data-write>测试连接</button>
            <button class="btn-link" data-act="edit" data-write>编辑</button>
            <button class="btn-link danger" data-act="delete" data-write>删除</button>
        </td>
    </tr>`;
}

function bodyHtml() {
    const kw = keyword.toLowerCase();
    const rows = hosts.filter(h => !kw || h.name.toLowerCase().includes(kw) || h.ip.includes(kw));
    return rows.length ? rows.map(rowHtml).join('') : emptyRow(9, keyword ? '未找到匹配的主机' : '暂无主机，点击右上角「添加主机」');
}

export function render() {
    return `
    ${demoBanner(demoMode)}
    <div class="card">
        <div class="toolbar">
            <input class="input" id="host-search" placeholder="搜索主机名 / IP..." style="width:220px">
            <button class="btn btn-ghost btn-sm" id="btn-refresh">刷新状态</button>
            <div class="spacer"></div>
            <button class="btn btn-primary" id="btn-add-host" data-write>+ 添加主机</button>
        </div>
        <div class="table-wrap">
            <table class="table">
                <thead>
                    <tr><th style="width:36px"></th><th>主机名</th><th>IP : 端口</th><th>用户</th><th>认证</th><th>标签</th><th>状态</th><th>最近连接</th><th>操作</th></tr>
                </thead>
                <tbody id="host-tbody">${loadingRow(9)}</tbody>
            </table>
        </div>
    </div>

    <div class="modal-mask" id="host-modal">
        <div class="modal">
            <div class="modal-header">
                <h3 id="host-modal-title">添加主机</h3>
                <button class="modal-close" data-close>×</button>
            </div>
            <div class="modal-body">
                <div class="form-row">
                    <div class="form-item">
                        <label>主机名</label>
                        <input class="input" id="h-name" placeholder="app-server-03">
                    </div>
                    <div class="form-item">
                        <label>IP 地址</label>
                        <input class="input" id="h-ip" placeholder="10.0.12.13">
                    </div>
                    <div class="form-item">
                        <label>SSH 端口</label>
                        <input class="input" id="h-port" type="number" value="22">
                    </div>
                    <div class="form-item">
                        <label>登录用户</label>
                        <input class="input" id="h-user" placeholder="root">
                    </div>
                </div>

                <div class="form-row">
                    <div class="form-item">
                        <label>认证方式</label>
                        <select class="select" id="h-auth" style="width:100%">
                            <option value="key">密钥认证（推荐）</option>
                            <option value="password">密码认证</option>
                        </select>
                    </div>
                    <div class="form-item">
                        <label>标签（逗号分隔）</label>
                        <input class="input" id="h-tags" placeholder="生产,应用">
                    </div>
                </div>

                <div class="form-item" id="field-key">
                    <label>私钥文件绝对路径</label>
                    <input class="input mono" id="h-keypath" placeholder="C:\\Users\\you\\.ssh\\id_rsa">
                    <div class="form-hint">留空则使用 ~/.ssh 下默认私钥；也可直接粘贴私钥内容（由 ssh2 解析）</div>
                </div>

                <div class="form-item" id="field-password" style="display:none">
                    <label>登录密码</label>
                    <input class="input" id="h-password" type="password" placeholder="留空表示不修改">
                    <div class="form-hint">使用 AES-256-GCM 加密后存储于本地库，界面不会回显明文</div>
                </div>
            </div>
            <div class="modal-footer">
                <button class="btn btn-ghost" data-close>取消</button>
                <button class="btn btn-primary" id="host-save">保存</button>
            </div>
        </div>
    </div>`;
}

export async function mount(root) {
    const tbody = root.querySelector('#host-tbody');
    const modal = root.querySelector('#host-modal');
    const authSel = root.querySelector('#h-auth');

    const refresh = async () => {
        try {
            hosts = await api.hosts.list();
            tbody.innerHTML = bodyHtml();
        } catch (err) {
            tbody.innerHTML = emptyRow(9, '主机列表加载失败：' + err.message);
        }
    };

    const openModal = (host) => {
        editingId = host ? host.id : null;
        root.querySelector('#host-modal-title').textContent = host ? `编辑主机 · ${host.name}` : '添加主机';
        root.querySelector('#h-name').value = host ? host.name : '';
        root.querySelector('#h-ip').value = host ? host.ip : '';
        root.querySelector('#h-port').value = host ? host.port : 22;
        root.querySelector('#h-user').value = host ? host.user : '';
        root.querySelector('#h-tags').value = host ? (host.tags || []).join(',') : '';
        authSel.value = host ? host.authType : 'key';
        root.querySelector('#h-keypath').value = host ? (host.keyPath || '') : '';
        root.querySelector('#h-password').value = '';
        toggleAuth();
        modal.classList.add('open');
    };

    const toggleAuth = () => {
        const isPwd = authSel.value === 'password';
        root.querySelector('#field-password').style.display = isPwd ? '' : 'none';
        root.querySelector('#field-key').style.display = isPwd ? 'none' : '';
    };

    authSel.addEventListener('change', toggleAuth);
    root.querySelector('#btn-add-host').addEventListener('click', () => openModal(null));
    modal.querySelectorAll('[data-close]').forEach(el => el.addEventListener('click', () => modal.classList.remove('open')));

    root.querySelector('#host-search').addEventListener('input', e => {
        keyword = e.target.value.trim();
        tbody.innerHTML = bodyHtml();
    });

    // 保存（新增 / 编辑 → hosts:save）
    root.querySelector('#host-save').addEventListener('click', async () => {
        const payload = {
            id: editingId || undefined,
            name: root.querySelector('#h-name').value.trim(),
            ip: root.querySelector('#h-ip').value.trim(),
            port: parseInt(root.querySelector('#h-port').value, 10) || 22,
            user: root.querySelector('#h-user').value.trim(),
            authType: authSel.value,
            keyPath: root.querySelector('#h-keypath').value.trim(),
            tags: root.querySelector('#h-tags').value.split(/[,，]/).map(s => s.trim()).filter(Boolean),
            password: root.querySelector('#h-password').value
        };
        if (!payload.name || !payload.ip || !payload.user) { toast('主机名、IP、登录用户均为必填', 'warn'); return; }

        const res = await api.hosts.save(payload);
        if (res && res.id) {
            toast(editingId ? '主机已更新' : '主机已添加', 'success');
            modal.classList.remove('open');
            await refresh();
        } else {
            toast((res && res.message) || '保存失败', 'danger');
        }
    });

    // 刷新状态：逐台连接测试（顺序执行，避免瞬时并发过高）
    root.querySelector('#btn-refresh').addEventListener('click', async (e) => {
        const btn = e.currentTarget;
        btn.disabled = true;
        btn.textContent = '探测中...';
        for (const host of [...hosts]) {
            const res = await api.hosts.test(host.id);
            const row = tbody.querySelector(`tr[data-id="${host.id}"] .status-cell`);
            if (row && res && res.host) row.innerHTML = statusBadge(res.host.status);
        }
        await refresh();
        btn.disabled = false;
        btn.textContent = '刷新状态';
        toast('主机状态探测完成', 'success');
    });

    // 行内操作
    tbody.addEventListener('click', async e => {
        const btn = e.target.closest('[data-act]');
        if (!btn) return;
        const id = btn.closest('tr').dataset.id;
        const host = hosts.find(h => h.id === id);
        const act = btn.dataset.act;

        if (act === 'edit') {
            openModal(host);
        } else if (act === 'delete') {
            if (!confirm(`确认删除主机 ${host.name}（${host.ip}）？`)) return;
            const res = await api.hosts.remove(id);
            if (res && res.ok) { toast('主机已删除', 'success'); await refresh(); }
            else toast('删除失败', 'danger');
        } else if (act === 'test') {
            btn.textContent = '连接中...';
            const res = await api.hosts.test(id);
            btn.textContent = '测试连接';
            toast(`${host.name}：${res.message || (res.ok ? '连接成功' : '连接失败')}`, res.ok ? 'success' : 'danger');
            await refresh();
        }
    });

    await refresh();
    applyReadonly(root);
}
