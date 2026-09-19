/**
 * 服务器运维 · 容器运维（Docker）
 * 视图：容器（含 compose 项目分组操作）· 镜像 · 编排（compose 文件）
 * 通道：docker:* 系列（见 handlers/dockerHandler.js）
 *
 * 端点模型：本机 socket（命名管道 / unix socket）或远程 TCP（可选 Bearer Token，
 * token 加密存储，可在「凭据台账」统一解密查看）。
 * compose 编排走本机 docker CLI（Docker Desktop 自带），纯 API 无法运行 compose。
 */
import { api, demoMode } from '../api.js';
import { esc, toast, demoBanner, emptyRow, guardAdmin, guardWrite, canModule, applyReadonly } from '../ui.js';

const TABS = [
    { id: 'containers', label: '容器' },
    { id: 'stacks', label: '编排项目' },
    { id: 'images', label: '镜像' },
    { id: 'compose', label: 'Compose 文件' }
];
const SHOW_ALL_KEY = 'sgops.docker.showAll';

let root = null;
let hosts = [];
let activeHostId = null;
let containers = [];
let stacks = [];
let images = [];
let composeScripts = [];
let showAll = true;
let timer = null;

const fmtSize = b => b > 1048576 ? (b / 1048576).toFixed(1) + ' MB' : (b / 1024).toFixed(0) + ' KB';
const stateBadge = s => s === 'running' ? '<span class="badge green">running</span>'
    : s === 'exited' || s === 'dead' ? '<span class="badge red">' + esc(s) + '</span>'
        : s === 'paused' ? '<span class="badge amber">paused</span>'
            : `<span class="badge gray">${esc(s || '-')}</span>`;
const activeHost = () => hosts.find(h => h.id === activeHostId) || null;

/* ------------------------------------------------------------------
 * 视图
 * ------------------------------------------------------------------ */

function containersTab() {
    const running = containers.filter(c => c.state === 'running').length;
    return `
    <div class="pane" data-pane="containers">
        <div class="toolbar">
            <span class="muted" style="font-size:12.5px">共 ${containers.length} 个 · 运行中 ${running}</span>
            <label class="switch" title="含已停止容器">
                <input type="checkbox" id="dc-all" ${showAll ? 'checked' : ''}><span class="track"></span>
            </label>
            <span class="muted" style="font-size:12px">显示全部</span>
            <div class="spacer"></div>
            <span class="muted" id="dc-updated" style="font-size:12px"></span>
            <button class="btn btn-ghost btn-sm" id="dc-refresh">刷新</button>
        </div>
        <div class="table-wrap" style="max-height:520px;overflow:auto">
            <table class="table">
                <thead><tr><th>名称</th><th>镜像</th><th>状态</th><th>端口映射</th><th>项目</th><th style="min-width:220px">操作</th></tr></thead>
                <tbody>${containers.length ? containers.map(c => `
                    <tr data-id="${esc(c.fullId || c.id)}" data-name="${esc(c.name)}">
                        <td><strong class="mono">${esc(c.name)}</strong><br><span class="muted mono" style="font-size:11px">${esc(c.id)}</span></td>
                        <td class="mono" style="font-size:12px">${esc(c.image)}</td>
                        <td>${stateBadge(c.state)}<br><span class="muted" style="font-size:11px">${esc(c.status || '')}</span></td>
                        <td class="mono" style="font-size:11.5px">${(c.ports || []).map(esc).join('<br>') || '<span class="muted">-</span>'}</td>
                        <td>${c.project ? `<span class="badge purple">${esc(c.project)}</span>` : '<span class="muted">-</span>'}</td>
                        <td style="white-space:nowrap">
                            ${c.state === 'running'
        ? `<button class="btn-link" data-act="stop" data-write>停止</button>
                               <button class="btn-link" data-act="restart" data-write>重启</button>
                               <button class="btn-link" data-act="exec" data-write>命令</button>`
        : `<button class="btn-link" data-act="start" data-write>启动</button>`}
                            <button class="btn-link" data-act="logs">日志</button>
                            <button class="btn-link danger" data-act="remove" data-write>删除</button>
                        </td>
                    </tr>`).join('') : emptyRow(6, '暂无容器（或端点不可达）')}</tbody>
            </table>
        </div>
    </div>`;
}

function stacksTab() {
    return `
    <div class="pane" data-pane="stacks" style="display:none">
        ${stacks.length ? stacks.map(s => `
        <div class="card" style="margin-bottom:12px">
            <div class="card-header">
                <div>
                    <div class="card-title mono">${esc(s.project)}</div>
                    <div class="card-desc">${s.total} 个容器 · 运行中 ${s.running}</div>
                </div>
                <div class="toolbar" style="margin:0">
                    <button class="btn btn-ghost btn-sm" data-stack="start" data-project="${esc(s.project)}" data-write>启动项目</button>
                    <button class="btn btn-ghost btn-sm" data-stack="stop" data-project="${esc(s.project)}" data-write>停止项目</button>
                    <button class="btn btn-ghost btn-sm" data-stack="restart" data-project="${esc(s.project)}" data-write>重启项目</button>
                </div>
            </div>
            <div class="table-wrap"><table class="table">
                <thead><tr><th>服务</th><th>容器</th><th>镜像</th><th>状态</th></tr></thead>
                <tbody>${s.containers.map(c => `<tr>
                    <td class="mono">${esc(c.service || '-')}</td>
                    <td class="mono">${esc(c.name)}</td>
                    <td class="mono" style="font-size:12px">${esc(c.image)}</td>
                    <td>${stateBadge(c.state)}</td>
                </tr>`).join('')}</tbody>
            </table></div>
        </div>`).join('') : '<div class="empty">当前端点上没有带 compose 标签的项目；未用 compose 启动的容器显示在「容器」页</div>'}
    </div>`;
}

function imagesTab() {
    return `
    <div class="pane" data-pane="images" style="display:none">
        <div class="toolbar"><div class="spacer"></div><button class="btn btn-ghost btn-sm" id="di-refresh">刷新</button></div>
        <div class="table-wrap" style="max-height:520px;overflow:auto">
            <table class="table">
                <thead><tr><th>Tag</th><th>镜像 ID</th><th>大小</th><th>创建时间</th><th>操作</th></tr></thead>
                <tbody>${images.length ? images.map(im => `
                    <tr data-id="${esc(im.id)}">
                        <td class="mono" style="font-size:12px">${(im.tags || []).map(esc).join('<br>') || '<span class="muted">&lt;none&gt;</span>'}</td>
                        <td class="muted mono">${esc(im.id)}</td>
                        <td>${fmtSize(im.size || 0)}</td>
                        <td class="muted">${im.created ? new Date(im.created).toLocaleString() : '-'}</td>
                        <td><button class="btn-link danger" data-act="image-del" data-write>删除</button></td>
                    </tr>`).join('') : emptyRow(5, '暂无镜像')}</tbody>
            </table>
        </div>
    </div>`;
}

function composeTab() {
    return `
    <div class="pane" data-pane="compose" style="display:none">
        <div class="alert info">
            <span>compose 编排固定作用于<strong>本机 docker CLI</strong>（Docker Desktop 自带），不读端点表；
            远程主机的编排可在「编排项目」页用 API 级启停，或到远程主机上执行。</span>
        </div>
        <div class="grid-2" style="align-items:start">
            <div>
                <div class="card-title" style="margin-bottom:8px">编排文件（来自脚本库 Compose 类型）</div>
                <div class="list" id="dcp-list">${composeScripts.length ? composeScripts.map(s => `
                    <div class="list-item" data-id="${esc(s.id)}">
                        <div style="min-width:0">
                            <div class="list-item-title">${esc(s.name)}</div>
                            <div class="list-item-sub">${esc(s.desc || '')}</div>
                        </div>
                        <div class="list-item-actions"><button class="btn-link" data-act="load">载入</button></div>
                    </div>`).join('') : '<div class="empty">脚本库中还没有 Compose 文件，可到「脚本管理 → + 新建脚本 → Compose」创建</div>'}</div>
            </div>
            <div>
                <div class="form-item">
                    <label>compose.yaml 内容</label>
                    <textarea class="textarea code-input" id="dcp-yaml" rows="14" spellcheck="false"
                        placeholder="services:&#10;  nginx:&#10;    image: nginx:alpine&#10;    ports:&#10;      - '8080:80'"></textarea>
                </div>
                <div class="toolbar">
                    <button class="btn btn-primary btn-sm" data-write id="dcp-up">up -d 启动</button>
                    <button class="btn btn-ghost btn-sm" data-write id="dcp-down">down 停止</button>
                    <button class="btn btn-ghost btn-sm" data-write id="dcp-ps">ps 查看</button>
                    <span class="muted" id="dcp-msg" style="font-size:12px"></span>
                </div>
                <pre class="code-output" id="dcp-out" style="display:none"></pre>
            </div>
        </div>
    </div>`;
}

export function render() {
    return `
    ${demoBanner(demoMode)}
    <div class="card">
        <div class="card-header">
            <div>
                <div class="card-title">容器运维</div>
                <div class="card-desc">Docker Engine API 直连 · 端点 Token 加密存储并纳入凭据台账 · 启停/命令/compose 全程审计</div>
            </div>
            <div class="toolbar" style="margin:0">
                <select class="select" id="dh-select" style="min-width:200px"></select>
                <button class="btn btn-ghost btn-sm" id="dh-manage" data-write>端点管理</button>
                <button class="btn btn-ghost btn-sm" id="dh-test">测试连接</button>
            </div>
        </div>
        <div class="tabs" id="dc-tabs">
            ${TABS.map(t => `<div class="tab ${t.id === 'containers' ? 'active' : ''}" data-tab="${t.id}">${t.label}</div>`).join('')}
        </div>
        <div id="dc-panes">${containersTab()}${stacksTab()}${imagesTab()}${composeTab()}</div>
    </div>

    <!-- 端点管理弹窗 -->
    <div class="modal-mask" id="dh-modal">
        <div class="modal" style="width:640px">
            <div class="modal-header"><h3>Docker 端点</h3><button class="modal-close" data-close>×</button></div>
            <div class="modal-body">
                <div class="table-wrap" style="max-height:200px;overflow:auto">
                    <table class="table">
                        <thead><tr><th>名称</th><th>类型</th><th>端点</th><th>Token</th><th>最近测试</th><th>操作</th></tr></thead>
                        <tbody id="dh-tbody"></tbody>
                    </table>
                </div>
                <div class="card-title" style="margin:14px 0 8px" id="dh-form-title">新增端点</div>
                <div class="form-row">
                    <div class="form-item"><label>名称</label><input class="input" id="dh-name" placeholder="生产 Docker"></div>
                    <div class="form-item"><label>类型</label>
                        <select class="select" id="dh-kind" style="width:100%">
                            <option value="pipe">本机 socket（管道/Unix）</option>
                            <option value="tcp">远程 TCP</option>
                        </select>
                    </div>
                </div>
                <div class="form-row" id="dh-tcp-row" style="display:none">
                    <div class="form-item"><label>主机</label><input class="input mono" id="dh-host" placeholder="10.0.12.30"></div>
                    <div class="form-item"><label>端口</label><input class="input mono" id="dh-port" placeholder="2375"></div>
                </div>
                <div class="form-item">
                    <label>Bearer Token（可空，加密存储；留空不修改）</label>
                    <input class="input" id="dh-token" type="password" autocomplete="off">
                    <div class="form-hint">远程 TCP 端点如启用 TLS/认证，在此填写访问令牌；台账中可解密查看。</div>
                </div>
                <div class="toolbar" style="justify-content:flex-end">
                    <button class="btn btn-ghost btn-sm" id="dh-form-cancel" style="display:none">取消编辑</button>
                    <button class="btn btn-primary btn-sm" id="dh-save" data-write>保存端点</button>
                </div>
            </div>
        </div>
    </div>

    <!-- 日志 / 命令 弹窗 -->
    <div class="modal-mask" id="dout-modal">
        <div class="modal" style="width:820px;max-width:94vw">
            <div class="modal-header"><h3 id="dout-title">输出</h3><button class="modal-close" data-close>×</button></div>
            <div class="modal-body">
                <div class="toolbar" id="dout-exec-row" style="display:none;margin-top:0">
                    <input class="input mono" id="dout-cmd" placeholder="容器内命令，如：df -h" style="flex:1">
                    <button class="btn btn-primary btn-sm" id="dout-run">执行</button>
                </div>
                <pre class="code-output" id="dout-body" style="max-height:420px">—</pre>
            </div>
            <div class="modal-footer"><button class="btn btn-ghost" data-close>关闭</button></div>
        </div>
    </div>`;
}

/* ------------------------------------------------------------------
 * 数据加载
 * ------------------------------------------------------------------ */

async function loadContainers() {
    const panes = root.querySelector('#dc-panes');
    if (!activeHostId) { containers = []; stacks = []; renderPanes(panes); return; }
    const res = await api.docker.containers(activeHostId, showAll);
    if (res && res.ok) {
        containers = res.containers || [];
        stacks = res.stacks || [];
    } else {
        containers = []; stacks = [];
        toast((res && res.message) || '容器列表加载失败', 'danger');
    }
    renderPanes(panes);
}

async function loadImages() {
    if (!activeHostId) return;
    const res = await api.docker.images(activeHostId);
    images = (res && res.ok) ? (res.images || []) : [];
    if (!(res && res.ok)) toast((res && res.message) || '镜像加载失败', 'danger');
    renderPanes(root.querySelector('#dc-panes'));
}

function renderPanes(panes) {
    panes.innerHTML = containersTab() + stacksTab() + imagesTab() + composeTab();
    panes.querySelectorAll('.pane').forEach(p => { p.style.display = p.dataset.pane === currentTab ? '' : 'none'; });
    bindPaneEvents(panes);
}

let currentTab = 'containers';

/* ------------------------------------------------------------------
 * 事件
 * ------------------------------------------------------------------ */

async function doRun(action, id, name, force) {
    if (!guardWrite(`容器 ${action}`, 'containers')) return;
    const verb = { start: '启动', stop: '停止', restart: '重启', kill: '强杀', remove: '删除', 'image-delete': '删除镜像' }[action] || action;
    if ((action === 'stop' || action === 'restart' || action === 'remove' || action === 'kill')
        && !confirm(`确认${verb}「${name}」？${action === 'remove' ? '（容器将被删除，卷保留）' : ''}`)) return;
    if (action === 'remove') { force = true; }
    const res = await api.docker.run(activeHostId, action, id, force);
    toast(res && res.ok ? `${verb}成功` : ((res && res.message) || `${verb}失败`), res && res.ok ? 'success' : 'danger');
    if (res && res.ok) await loadContainers();
}

function openOutput(title, text, execMode) {
    const modal = root.querySelector('#dout-modal');
    root.querySelector('#dout-title').textContent = title;
    root.querySelector('#dout-body').textContent = text || '（空）';
    root.querySelector('#dout-exec-row').style.display = execMode ? '' : 'none';
    modal.classList.add('open');
}

function bindPaneEvents(panes) {
    panes.querySelector('#dc-all').addEventListener('change', e => {
        showAll = e.target.checked;
        localStorage.setItem(SHOW_ALL_KEY, showAll ? '1' : '0');
        loadContainers();
    });
    panes.querySelector('#dc-refresh').addEventListener('click', loadContainers);
    panes.querySelector('#di-refresh').addEventListener('click', loadImages);

    panes.querySelector('[data-pane="containers"] tbody')
        .addEventListener('click', async e => {
            const btn = e.target.closest('[data-act]');
            if (!btn) return;
            const tr = btn.closest('tr');
            const id = tr.dataset.id; const name = tr.dataset.name;
            const act = btn.dataset.act;
            if (act === 'logs') {
                openOutput(`日志 · ${name}`, '读取中...');
                const res = await api.docker.logs(activeHostId, id, 300);
                root.querySelector('#dout-body').textContent = (res && res.ok) ? res.text : ((res && res.message) || '读取失败');
            } else if (act === 'exec') {
                openOutput(`容器命令 · ${name}`, '输入命令后回车执行', true);
                root.querySelector('#dout-exec-row').dataset.target = id;
                root.querySelector('#dout-exec-row').dataset.targetName = name;
            } else {
                await doRun(act, id, name);
            }
        });

    panes.querySelector('[data-pane="stacks"]').addEventListener('click', async e => {
        const btn = e.target.closest('[data-stack]');
        if (!btn) return;
        if (!guardWrite('项目级操作', 'containers')) return;
        const { stack: action, project } = btn.dataset;
        if ((action === 'stop' || action === 'restart') && !confirm(`确认${action === 'stop' ? '停止' : '重启'}项目「${project}」的所有容器？`)) return;
        btn.disabled = true;
        const res = await api.docker.stackRun(activeHostId, project, action);
        btn.disabled = false;
        if (res && res.ok) {
            const failed = (res.results || []).filter(r => !r.ok);
            toast(`项目 ${action} 完成${failed.length ? ` · ${failed.length} 个容器失败` : ''}`, failed.length ? 'warn' : 'success');
            await loadContainers();
        } else toast((res && res.message) || '操作失败', 'danger');
    });

    panes.querySelector('[data-pane="images"] tbody').addEventListener('click', async e => {
        const btn = e.target.closest('[data-act="image-del"]');
        if (!btn) return;
        if (!guardAdmin('删除镜像')) return;
        const id = btn.closest('tr').dataset.id;
        if (!confirm(`删除镜像 ${id}？（被容器占用时会失败）`)) return;
        await doRun('image-delete', id, id);
        await loadImages();
    });

    const composePane = panes.querySelector('[data-pane="compose"]');
    composePane.querySelector('#dcp-list').addEventListener('click', e => {
        const btn = e.target.closest('[data-act="load"]');
        if (!btn) return;
        const item = composeScripts.find(s => s.id === btn.closest('[data-id]').dataset.id);
        if (item) composePane.querySelector('#dcp-yaml').value = item.content || '';
    });
    const runCompose = async action => {
        if (!guardAdmin(`docker compose ${action}`)) return;
        const yaml = composePane.querySelector('#dcp-yaml').value;
        const msg = composePane.querySelector('#dcp-msg');
        const out = composePane.querySelector('#dcp-out');
        if (!yaml.trim()) { toast('请先填写或载入 compose 内容', 'warn'); return; }
        msg.textContent = `docker compose ${action} 执行中...`;
        const res = await api.docker.compose(yaml, action);
        msg.textContent = res && res.ok ? '执行成功' : ((res && res.message) || '执行失败');
        out.style.display = res && res.output ? '' : 'none';
        out.textContent = res && res.output || '';
        if (res && res.ok && action !== 'ps') await loadContainers();
    };
    composePane.querySelector('#dcp-up').addEventListener('click', () => runCompose('up'));
    composePane.querySelector('#dcp-down').addEventListener('click', () => runCompose('down'));
    composePane.querySelector('#dcp-ps').addEventListener('click', () => runCompose('ps'));
}

/* ---------------- 端点管理 ---------------- */

function paintHostSelect() {
    const sel = root.querySelector('#dh-select');
    sel.innerHTML = hosts.length
        ? hosts.map(h => `<option value="${esc(h.id)}" ${h.id === activeHostId ? 'selected' : ''}>${esc(h.name)}${h.kind === 'tcp' ? ` (${esc(h.host)})` : ''}</option>`).join('')
        : '<option value="">暂无端点，点击「端点管理」新增</option>';
}

function paintHostTable() {
    const tbody = root.querySelector('#dh-tbody');
    tbody.innerHTML = hosts.length ? hosts.map(h => `
        <tr data-id="${esc(h.id)}">
            <td><strong>${esc(h.name)}</strong></td>
            <td>${h.kind === 'tcp' ? 'TCP' : '本机'}</td>
            <td class="mono" style="font-size:11.5px">${h.kind === 'tcp' ? esc(`${h.host}:${h.port}`) : 'socket'}</td>
            <td>${h.hasToken ? `<span class="mono muted">${esc(h.tokenMasked)}</span>` : '<span class="muted">-</span>'}</td>
            <td class="muted" style="font-size:11.5px">${esc(h.lastTestAt || '-')} ${h.status === 'ok' ? '<span class="badge green">通</span>' : h.status === 'error' ? '<span class="badge red">断</span>' : ''}</td>
            <td>
                <button class="btn-link" data-hact="edit">编辑</button>
                <button class="btn-link" data-hact="test">测试</button>
                <button class="btn-link danger" data-hact="del">删除</button>
            </td>
        </tr>`).join('') : '<tr><td colspan="6"><div class="empty">暂无端点</div></td></tr>';
}

let editingHost = null;

function fillHostForm(h) {
    editingHost = h || null;
    root.querySelector('#dh-form-title').textContent = h ? `编辑端点 · ${h.name}` : '新增端点';
    root.querySelector('#dh-name').value = h ? h.name : '';
    root.querySelector('#dh-kind').value = h ? h.kind : 'pipe';
    root.querySelector('#dh-host').value = h ? h.host || '' : '';
    root.querySelector('#dh-port').value = h ? h.port || '' : '2375';
    root.querySelector('#dh-token').value = '';
    root.querySelector('#dh-form-cancel').style.display = h ? '' : 'none';
    root.querySelector('#dh-tcp-row').style.display = (h ? h.kind : 'pipe') === 'tcp' ? '' : 'none';
}

/* ------------------------------------------------------------------
 * 挂载
 * ------------------------------------------------------------------ */

export async function mount(r) {
    root = r;
    showAll = localStorage.getItem(SHOW_ALL_KEY) !== '0';
    currentTab = 'containers';

    try {
        const [hs, ss] = await Promise.all([api.docker.hosts.list(), api.scripts.list()]);
        hosts = Array.isArray(hs) ? hs : [];
        composeScripts = (Array.isArray(ss) ? ss : []).filter(s => s.type === 'compose');
        composeScripts.forEach(s => { if (!s.content) s.content = ''; });
    } catch (err) {
        hosts = []; composeScripts = [];
    }
    try {
        // 脚本列表不含正文，逐个补齐 compose 正文（数量小）
        await Promise.all(composeScripts.map(async s => {
            const d = await api.scripts.detail(s.id);
            if (d && d.content) s.content = d.content;
        }));
    } catch (err) { /* 演示模式忽略 */ }

    activeHostId = (hosts.find(h => h.kind === 'pipe') || hosts[0] || {}).id || null;
    paintHostSelect();

    root.querySelector('#dh-select').addEventListener('change', e => {
        activeHostId = e.target.value;
        loadContainers();
    });
    root.querySelector('#dh-test').addEventListener('click', async () => {
        if (!activeHostId) { toast('请先配置端点', 'warn'); return; }
        const res = await api.docker.hosts.test(activeHostId);
        toast(res && res.ok ? res.message : `连接失败：${(res && res.message) || ''}`, res && res.ok ? 'success' : 'danger');
        const local = hosts.find(h => h.id === activeHostId);
        if (local) { local.status = res && res.ok ? 'ok' : 'error'; local.lastTestAt = '刚刚'; }
        if (canModule('containers', 'admin')) { paintHostTable(); }
        if (res && res.ok) await loadContainers();
    });

    root.querySelector('#dh-manage').addEventListener('click', () => {
        if (!guardAdmin('管理 Docker 端点')) return;
        fillHostForm(null);
        paintHostTable();
        root.querySelector('#dh-modal').classList.add('open');
    });
    root.querySelectorAll('#dh-modal [data-close]').forEach(el =>
        el.addEventListener('click', () => root.querySelector('#dh-modal').classList.remove('open')));
    root.querySelector('#dh-kind').addEventListener('change', e => {
        root.querySelector('#dh-tcp-row').style.display = e.target.value === 'tcp' ? '' : 'none';
    });
    root.querySelector('#dh-form-cancel').addEventListener('click', () => fillHostForm(null));
    root.querySelector('#dh-save').addEventListener('click', async () => {
        if (!guardAdmin('保存 Docker 端点')) return;
        const name = root.querySelector('#dh-name').value.trim();
        if (!name) { toast('请填写端点名称', 'warn'); return; }
        const payload = {
            id: editingHost ? editingHost.id : undefined,
            name,
            kind: root.querySelector('#dh-kind').value,
            host: root.querySelector('#dh-host').value.trim(),
            port: root.querySelector('#dh-port').value.trim(),
            token: root.querySelector('#dh-token').value
        };
        const res = await api.docker.hosts.save(payload);
        if (res && res.ok) {
            toast('端点已保存', 'success');
            const list = await api.docker.hosts.list();
            if (Array.isArray(list)) hosts = list;
            const saved = hosts.find(h => h.id === (res.host && res.host.id));
            if (saved) activeHostId = saved.id;
            paintHostSelect(); paintHostTable(); fillHostForm(null);
            loadContainers();
        } else toast((res && res.message) || '保存失败', 'danger');
    });
    root.querySelector('#dh-tbody').addEventListener('click', async e => {
        const btn = e.target.closest('[data-hact]');
        if (!btn) return;
        const id = btn.closest('tr').dataset.id;
        const host = hosts.find(h => h.id === id);
        if (!host) return;
        if (btn.dataset.hact === 'edit') { fillHostForm(host); return; }
        if (btn.dataset.hact === 'test') {
            const res = await api.docker.hosts.test(id);
            toast(res && res.ok ? res.message : `连接失败：${(res && res.message) || ''}`, res && res.ok ? 'success' : 'danger');
            host.status = res && res.ok ? 'ok' : 'error';
            host.lastTestAt = '刚刚';
            paintHostTable();
            return;
        }
        if (!guardAdmin('删除 Docker 端点')) return;
        if (!confirm(`删除端点「${host.name}」？`)) return;
        const res = await api.docker.hosts.remove(id);
        if (res && res.ok) {
            hosts = hosts.filter(h => h.id !== id);
            if (activeHostId === id) activeHostId = (hosts[0] || {}).id || null;
            paintHostSelect(); paintHostTable();
            loadContainers();
        }
    });

    /* 输出弹窗（日志/命令共用） */
    root.querySelectorAll('#dout-modal [data-close]').forEach(el =>
        el.addEventListener('click', () => root.querySelector('#dout-modal').classList.remove('open')));
    const runExec = async () => {
        const row = root.querySelector('#dout-exec-row');
        const cmd = root.querySelector('#dout-cmd').value.trim();
        if (!cmd) return;
        if (!guardAdmin('容器内执行命令')) return;
        const out = root.querySelector('#dout-body');
        out.textContent = '执行中...';
        const res = await api.docker.exec(activeHostId, row.dataset.target, cmd);
        out.textContent = (res && res.ok) ? (res.output || '（无输出）') : ((res && res.message) || '执行失败');
    };
    root.querySelector('#dout-run').addEventListener('click', runExec);
    root.querySelector('#dout-cmd').addEventListener('keydown', e => { if (e.key === 'Enter') runExec(); });

    /* 页签 */
    root.querySelector('#dc-tabs').addEventListener('click', e => {
        const tab = e.target.closest('.tab');
        if (!tab) return;
        currentTab = tab.dataset.tab;
        root.querySelectorAll('#dc-tabs .tab').forEach(t => t.classList.toggle('active', t === tab));
        root.querySelectorAll('#dc-panes .pane').forEach(p => { p.style.display = p.dataset.pane === currentTab ? '' : 'none'; });
        if (currentTab === 'images' && !images.length) loadImages();
    });

    bindPaneEvents(root.querySelector('#dc-panes'));
    if (activeHostId) await loadContainers();

    /* 自动刷新（10s，页面切走由 router 重挂载自然解除） */
    timer = setInterval(() => {
        if (currentTab === 'containers' && activeHostId && !document.hidden) {
            api.docker.containers(activeHostId, showAll).then(res => {
                if (res && res.ok) { containers = res.containers || []; stacks = res.stacks || []; renderPanes(root.querySelector('#dc-panes')); }
            }).catch(() => {});
        }
    }, 10000);

    applyReadonly(root);
}
