/**
 * 服务器运维 · 容器运维（Docker + Kubernetes 双引擎）
 *
 * 引擎切换：Docker | Kubernetes | 命令速查
 * Docker —— 端点支持 本机 socket / 远程 TCP / SSH 桥接（推荐，复用主机凭据体系，
 *            经 docker system dial-stdio 桥接 API，无需开放 2375）；
 *            容器操作 / 日志 / 容器命令 / compose 项目 / 镜像（含详情与分层历史）/ 引擎状态卡。
 * K8s    —— 集群支持 本机 kubectl / SSH 跳板机 kubectl（-o json 结构化输出）；
 *            概览（节点/命名空间/工作负载/Pod 统计/告警事件）、资源快查、Pod 日志、
 *            管理员终端（任意 kubectl，黑白名单 + 审计）。
 * 命令速查 —— Docker / compose / kubectl 常用命令卡片，一键复制，kubectl 组可直接送入终端执行。
 *
 * 通道：docker:* / kube:*（见 handlers/dockerHandler.js、handlers/kubeHandler.js）
 */
import { api, demoMode } from '../api.js';
import { esc, toast, demoBanner, emptyRow, guardAdmin, guardWrite, canAdmin, applyReadonly } from '../ui.js';

const SHOW_ALL_KEY = 'sgops.docker.showAll';
const fmtSize = b => b > 1073741824 ? (b / 1073741824).toFixed(2) + ' GB'
    : b > 1048576 ? (b / 1048576).toFixed(1) + ' MB' : (b / 1024).toFixed(0) + ' KB';

const state = {
    engine: 'docker',
    // Docker
    hosts: [], hostOptions: [], activeHostId: null, dockerTab: 'containers',
    containers: [], stacks: [], images: [], composeScripts: [], showAll: true,
    dockerInfo: null,
    // K8s
    clusters: [], kubeHosts: [], activeClusterId: null, kubeResources: [],
    overview: null, overviewError: '', kubeRows: null, kubeRowsMeta: null,
    timer: null
};

let root = null;

const activeHost = () => state.hosts.find(h => h.id === state.activeHostId) || null;
const activeCluster = () => state.clusters.find(c => c.id === state.activeClusterId) || null;

const stateBadge = s => s === 'running' || s === 'Ready' || s === 'Running' ? '<span class="badge green">' + esc(s) + '</span>'
    : s === 'exited' || s === 'dead' || s === 'NotReady' || s === 'Failed' ? '<span class="badge red">' + esc(s) + '</span>'
        : s === 'paused' || s === 'Pending' ? '<span class="badge amber">' + esc(s) + '</span>'
            : `<span class="badge gray">${esc(s || '-')}</span>`;

/* ---------------- 命令速查数据 ---------------- */

const CHEATS = [
    {
        group: 'Docker 日常', engine: 'docker', items: [
            { cmd: 'docker ps -a --format "table {{.Names}}\t{{.Image}}\t{{.Status}}"', desc: '列出全部容器' },
            { cmd: 'docker logs --tail 200 -f <容器名>', desc: '跟踪容器日志' },
            { cmd: 'docker exec -it <容器名> /bin/sh', desc: '进入容器终端' },
            { cmd: 'docker stats --no-stream', desc: '容器资源占用快照' },
            { cmd: 'docker inspect <容器名> | less', desc: '查看容器完整配置' },
            { cmd: 'docker system prune -f', desc: '清理悬空镜像/停止容器（慎用）' }
        ]
    },
    {
        group: 'Docker Compose', engine: 'docker', items: [
            { cmd: 'docker compose up -d', desc: '后台启动项目' },
            { cmd: 'docker compose ps', desc: '查看项目容器' },
            { cmd: 'docker compose logs -f --tail 100 <服务名>', desc: '跟踪某服务日志' },
            { cmd: 'docker compose restart <服务名>', desc: '重启单个服务' },
            { cmd: 'docker compose down', desc: '停止并移除项目（保留卷）' },
            { cmd: 'docker compose pull && docker compose up -d', desc: '拉新镜像并滚动更新' }
        ]
    },
    {
        group: '容器排障', engine: 'docker', items: [
            { cmd: 'docker inspect -f "{{json .State}}" <容器名>', desc: '看退出码/OOM 状态' },
            { cmd: 'docker events --since 30m --until now', desc: '最近事件流' },
            { cmd: 'docker network inspect bridge', desc: '网络与容器 IP' },
            { cmd: 'docker volume ls && docker volume inspect <卷>', desc: '数据卷排查' },
            { cmd: 'docker cp <容器名>:/path/file ./', desc: '从容器拷出文件' }
        ]
    },
    {
        group: 'K8s 集群状态', engine: 'kube', items: [
            { cmd: 'kubectl get nodes -o wide', desc: '节点总览' },
            { cmd: 'kubectl top nodes', desc: '节点资源用量（需 metrics-server）' },
            { cmd: 'kubectl get pods -A -o wide', desc: '全命名空间 Pod' },
            { cmd: 'kubectl get events -A --field-selector type=Warning | tail -20', desc: '最近告警事件' },
            { cmd: 'kubectl describe node <节点名> | tail -30', desc: '节点 Conditions/资源压力' },
            { cmd: 'kubectl get deployments -A', desc: '各命名空间工作负载' }
        ]
    },
    {
        group: 'K8s 排障', engine: 'kube', items: [
            { cmd: 'kubectl logs -n <ns> <pod> --tail=200', desc: 'Pod 日志' },
            { cmd: 'kubectl logs -n <ns> <pod> --previous', desc: '上次崩溃前日志' },
            { cmd: 'kubectl describe pod -n <ns> <pod>', desc: '事件与探针状态' },
            { cmd: 'kubectl exec -it -n <ns> <pod> -- /bin/sh', desc: '进入 Pod' },
            { cmd: 'kubectl rollout restart deployment/<名> -n <ns>', desc: '滚动重启部署' },
            { cmd: 'kubectl rollout undo deployment/<名> -n <ns>', desc: '回滚上一次发布' },
            { cmd: 'kubectl debug -it <pod> --image=busybox --target=<容器>', desc: '临时调试容器（1.23+）' }
        ]
    }
];

/* ==================================================================
 * 视图
 * ================================================================== */

function dockerView() {
    return `
    <div class="eng-pane" data-eng="docker" style="${state.engine === 'docker' ? '' : 'display:none'}">
        <div class="card">
            <div class="card-header">
                <div>
                    <div class="card-title">Docker 引擎</div>
                    <div class="card-desc" id="dh-caption">端点：本机 socket / TCP / SSH 桥接</div>
                </div>
                <div class="toolbar" style="margin:0">
                    <select class="select" id="dh-select" style="min-width:190px"></select>
                    <button class="btn btn-ghost btn-sm" id="dh-manage" data-write>端点管理</button>
                    <button class="btn btn-ghost btn-sm" id="dh-test">测试</button>
                </div>
            </div>
            <div class="dc-info" id="dc-info"><span class="muted" style="font-size:12.5px">点「测试」查看引擎状态（版本 / 容器与镜像计数 / 存储驱动）</span></div>
            <div class="tabs" id="dc-tabs">
                <div class="tab ${state.dockerTab === 'containers' ? 'active' : ''}" data-tab="containers">容器</div>
                <div class="tab ${state.dockerTab === 'stacks' ? 'active' : ''}" data-tab="stacks">编排项目</div>
                <div class="tab ${state.dockerTab === 'images' ? 'active' : ''}" data-tab="images">镜像</div>
                <div class="tab ${state.dockerTab === 'compose' ? 'active' : ''}" data-tab="compose">Compose 文件</div>
            </div>
            <div id="dc-panes">${containersPane()}${stacksPane()}${imagesPane()}${composePane()}</div>
        </div>
    </div>`;
}

function containersPane() {
    return `
    <div class="pane" data-dtab="containers">
        <div class="toolbar">
            <label class="switch" title="含已停止容器"><input type="checkbox" id="dc-all" ${state.showAll ? 'checked' : ''}><span class="track"></span></label>
            <span class="muted" style="font-size:12px">显示全部</span>
            <div class="spacer"></div>
            <span class="muted" style="font-size:12px">运行中 ${state.containers.filter(c => c.state === 'running').length} / ${state.containers.length}</span>
            <button class="btn btn-ghost btn-sm" id="dc-refresh">刷新（10s 自动）</button>
        </div>
        <div class="table-wrap" style="max-height:440px;overflow:auto">
            <table class="table">
                <thead><tr><th>名称</th><th>镜像</th><th>状态</th><th>端口</th><th>项目</th><th style="min-width:230px">操作</th></tr></thead>
                <tbody id="dc-tbody">${emptyRow(6, '尚未加载')}</tbody>
            </table>
        </div>
    </div>`;
}

function stacksPane() {
    return `<div class="pane" data-dtab="stacks" style="display:none"><div id="ds-body">${state.stacks.length ? '' : '<div class="empty">当前端点上没有 compose 项目</div>'}</div></div>`;
}

function imagesPane() {
    return `
    <div class="pane" data-dtab="images" style="display:none">
        <div class="toolbar"><div class="spacer"></div><button class="btn btn-ghost btn-sm" id="di-refresh">刷新</button></div>
        <div class="table-wrap" style="max-height:440px;overflow:auto">
            <table class="table">
                <thead><tr><th>Tag</th><th>镜像 ID</th><th>大小</th><th>创建时间</th><th style="width:130px">操作</th></tr></thead>
                <tbody id="di-tbody">${emptyRow(5, '尚未加载')}</tbody>
            </table>
        </div>
    </div>`;
}

function composePane() {
    return `
    <div class="pane" data-dtab="compose" style="display:none">
        <div class="alert info"><span>compose 编排固定作用于<strong>本机 docker CLI</strong>；远程主机的项目操作请用「编排项目」页（API 级）或 K8s 页。</span></div>
        <div class="grid-2" style="align-items:start">
            <div>
                <div class="card-title" style="margin-bottom:8px">编排文件（脚本库 Compose 类型）</div>
                <div class="list" id="dcp-list"></div>
            </div>
            <div>
                <div class="form-item"><textarea class="textarea code-input" id="dcp-yaml" rows="13" spellcheck="false" placeholder="services:&#10;  nginx:&#10;    image: nginx:alpine"></textarea></div>
                <div class="toolbar">
                    <button class="btn btn-primary btn-sm" data-write id="dcp-up">up -d</button>
                    <button class="btn btn-ghost btn-sm" data-write id="dcp-down">down</button>
                    <button class="btn btn-ghost btn-sm" data-write id="dcp-ps">ps</button>
                    <span class="muted" id="dcp-msg" style="font-size:12px"></span>
                </div>
                <pre class="code-output" id="dcp-out" style="display:none"></pre>
            </div>
        </div>
    </div>`;
}

function kubeView() {
    return `
    <div class="eng-pane" data-eng="kube" style="${state.engine === 'kube' ? '' : 'display:none'}">
        <div class="card">
            <div class="card-header">
                <div>
                    <div class="card-title">Kubernetes 集群</div>
                    <div class="card-desc">本机 kubectl 或 SSH 跳板机执行（-o json 结构化回传，不暴露 API Server）</div>
                </div>
                <div class="toolbar" style="margin:0">
                    <select class="select" id="kc-select" style="min-width:200px"></select>
                    <button class="btn btn-ghost btn-sm" id="kc-manage" data-write>集群管理</button>
                    <button class="btn btn-ghost btn-sm" id="kc-test">测试</button>
                    <button class="btn btn-primary btn-sm" id="kc-refresh">刷新概览</button>
                </div>
            </div>
            <div id="kube-body"><div class="empty">选择集群后点「刷新概览」</div></div>
        </div>
        <div class="card">
            <div class="card-header">
                <div>
                    <div class="card-title">资源快查</div>
                    <div class="card-desc">常用只读视图；Pod 行可看日志</div>
                </div>
                <div class="toolbar" style="margin:0">
                    <select class="select" id="kq-res" style="width:140px"></select>
                    <input class="input" id="kq-ns" placeholder="namespace（空=全部）" style="width:150px">
                    <button class="btn btn-ghost btn-sm" id="kq-go">查询</button>
                </div>
            </div>
            <div id="kq-body"><div class="empty">选择资源类型后查询</div></div>
        </div>
        <div class="card" id="kc-term-card" style="display:none">
            <div class="card-header">
                <div>
                    <div class="card-title">kubectl 终端（管理员）</div>
                    <div class="card-desc">对当前集群执行任意 kubectl 子命令（黑白名单校验 + 审计留痕）</div>
                </div>
            </div>
            <div class="toolbar" style="margin-top:0">
                <input class="input mono" id="kt-cmd" placeholder="如：get pods -n kube-system -o wide（无需 kubectl 前缀）" style="flex:1">
                <button class="btn btn-primary btn-sm" data-write id="kt-run">执行</button>
            </div>
            <pre class="code-output" id="kt-out" style="display:none"></pre>
        </div>
    </div>`;
}

function cheatsView() {
    return `
    <div class="eng-pane" data-eng="cheats" style="${state.engine === 'cheats' ? '' : 'display:none'}">
        <div class="card">
            <div class="card-header">
                <div>
                    <div class="card-title">常用命令速查</div>
                    <div class="card-desc">Docker / Compose / K8s 高频命令；kubectl 组可一键送入终端执行</div>
                </div>
            </div>
            <div class="grid-2">
                ${CHEATS.map(g => `
                <div class="card" style="box-shadow:none;border:1px solid var(--border)">
                    <div class="card-title" style="margin-bottom:8px">${esc(g.group)}</div>
                    ${g.items.map(it => `
                    <div class="cheat-item">
                        <code class="cheat-cmd mono">${esc(it.cmd)}</code>
                        <div class="cheat-ops">
                            <span class="muted cheat-desc">${esc(it.desc)}</span>
                            <button class="btn-link" data-copy="${esc(it.cmd)}">复制</button>
                            ${g.engine === 'kube' ? `<button class="btn-link" data-tokube="${esc(it.cmd)}">送终端</button>` : ''}
                        </div>
                    </div>`).join('')}
                </div>`).join('')}
            </div>
        </div>
    </div>`;
}

function kubeOverviewHtml(o) {
    const kpi = (label, value, cls) => `<div class="ovw-kpi"><span class="muted">${label}</span><strong class="${cls || ''}">${esc(value)}</strong></div>`;
    return `
    <div class="ovw-kpis">
        ${kpi('节点 Ready', `${o.nodeReady}/${o.nodeTotal}`, o.nodeReady === o.nodeTotal ? 'text-success' : 'text-danger')}
        ${kpi('Pod 运行中', o.podsRunning, '')}
        ${kpi('Pod 异常', o.podsFailed + o.podsPending, (o.podsFailed + o.podsPending) ? 'text-danger' : '')}
        ${kpi('命名空间', o.namespaces.length, '')}
        ${kpi('Deployment', o.deployments.length, '')}
        ${o.serverVersion ? kpi('版本', o.serverVersion, '') : ''}
    </div>
    <div class="grid-2" style="align-items:start;margin-top:12px">
        <div>
            <div class="card-title" style="margin-bottom:6px">节点</div>
            <div class="table-wrap" style="max-height:240px;overflow:auto"><table class="table">
                <thead><tr><th>节点</th><th>状态</th><th>版本</th><th>运行</th></tr></thead>
                <tbody>${o.nodes.length ? o.nodes.map(n => `<tr><td class="mono">${esc(n.name)}</td><td>${stateBadge(n.ready === 'True' ? 'Ready' : (n.ready || 'NotReady'))}</td><td class="muted">${esc(n.age || '')}</td><td>${esc(n.status || '')}</td></tr>`).join('') : emptyRow(4, '无节点')}</tbody>
            </table></div>
            <div class="card-title" style="margin:12px 0 6px">工作负载（deployments）</div>
            <div class="table-wrap" style="max-height:260px;overflow:auto"><table class="table">
                <thead><tr><th>命名空间</th><th>名称</th><th>就绪</th><th>运行</th></tr></thead>
                <tbody>${o.deployments.length ? o.deployments.map(d => `<tr><td class="muted">${esc(d.ns)}</td><td class="mono">${esc(d.name)}</td><td>${esc(d.ready || '')}</td><td class="muted">${esc(d.age || '')}</td></tr>`).join('') : emptyRow(4, '无 Deployment')}</tbody>
            </table></div>
        </div>
        <div>
            <div class="card-title" style="margin-bottom:6px">Warning 事件（最近）</div>
            ${o.warnings.length ? `<div class="table-wrap" style="max-height:300px;overflow:auto"><table class="table"><tbody>
                ${o.warnings.map(w => `<tr>
                    <td class="muted" style="width:56px;font-size:11.5px">${esc(w.age)}</td>
                    <td style="width:120px"><span class="badge amber">${esc(w.reason)}</span><br><span class="muted mono" style="font-size:11px">${esc(w.ns)}/${esc(w.object)}</span></td>
                    <td class="mono" style="font-size:11.5px;word-break:break-all">${esc(w.message)}</td>
                </tr>`).join('')}
            </tbody></table></div>` : '<div class="empty">近期无 Warning 事件</div>'}
            <div class="card-title" style="margin:12px 0 6px">命名空间</div>
            <div class="etl-col-chips">${o.namespaces.map(n => `<span class="etl-col-chip">${esc(n)}</span>`).join('') || '<span class="muted">-</span>'}</div>
        </div>
    </div>`;
}

export function render() {
    return `
    ${demoBanner(demoMode)}
    <div class="eng-seg" id="eng-seg">
        <button class="eng-btn ${state.engine === 'docker' ? 'active' : ''}" data-eng="docker">Docker</button>
        <button class="eng-btn ${state.engine === 'kube' ? 'active' : ''}" data-eng="kube">Kubernetes</button>
        <button class="eng-btn ${state.engine === 'cheats' ? 'active' : ''}" data-eng="cheats">命令速查</button>
    </div>
    ${dockerView()}${kubeView()}${cheatsView()}

    <!-- Docker 端点管理 -->
    <div class="modal-mask" id="dh-modal">
        <div class="modal" style="width:660px">
            <div class="modal-header"><h3>Docker 端点</h3><button class="modal-close" data-close>×</button></div>
            <div class="modal-body">
                <div class="table-wrap" style="max-height:190px;overflow:auto">
                    <table class="table">
                        <thead><tr><th>名称</th><th>类型</th><th>目标</th><th>Token</th><th>操作</th></tr></thead>
                        <tbody id="dh-tbody"></tbody>
                    </table>
                </div>
                <div class="card-title" style="margin:14px 0 8px" id="dh-form-title">新增端点</div>
                <div class="form-row">
                    <div class="form-item"><label>名称</label><input class="input" id="dh-name"></div>
                    <div class="form-item"><label>类型</label>
                        <select class="select" id="dh-kind" style="width:100%">
                            <option value="pipe">本机 socket（管道/Unix）</option>
                            <option value="ssh">SSH 桥接（推荐远程，复用主机凭据）</option>
                            <option value="tcp">远程 TCP（2375/2376）</option>
                        </select>
                    </div>
                </div>
                <div class="form-row" id="dh-ssh-row" style="display:none">
                    <div class="form-item"><label>关联主机</label><select class="select" id="dh-hostid" style="width:100%"></select>
                        <div class="form-hint">远端需已安装 docker CLI；凭据在「主机管理/凭据台账」维护</div></div>
                </div>
                <div class="form-row" id="dh-tcp-row" style="display:none">
                    <div class="form-item"><label>主机</label><input class="input mono" id="dh-host"></div>
                    <div class="form-item"><label>端口</label><input class="input mono" id="dh-port" placeholder="2375"></div>
                </div>
                <div class="form-item">
                    <label>Bearer Token（可空，TCP 网关认证用；加密存储并入台账）</label>
                    <input class="input" id="dh-token" type="password" autocomplete="off">
                </div>
                <div class="toolbar" style="justify-content:flex-end">
                    <button class="btn btn-ghost btn-sm" id="dh-form-cancel" style="display:none">取消编辑</button>
                    <button class="btn btn-primary btn-sm" data-write id="dh-save">保存端点</button>
                </div>
            </div>
        </div>
    </div>

    <!-- K8s 集群管理 -->
    <div class="modal-mask" id="kc-modal">
        <div class="modal" style="width:600px">
            <div class="modal-header"><h3>K8s 集群配置</h3><button class="modal-close" data-close>×</button></div>
            <div class="modal-body">
                <div class="table-wrap" style="max-height:180px;overflow:auto">
                    <table class="table">
                        <thead><tr><th>名称</th><th>模式</th><th>跳板主机</th><th>状态</th><th>操作</th></tr></thead>
                        <tbody id="kc-tbody"></tbody>
                    </table>
                </div>
                <div class="card-title" style="margin:14px 0 8px" id="kc-form-title">新增集群</div>
                <div class="form-row">
                    <div class="form-item"><label>名称</label><input class="input" id="kc-name"></div>
                    <div class="form-item"><label>访问模式</label>
                        <select class="select" id="kc-mode" style="width:100%">
                            <option value="local">本机 kubectl（平台机装 kubectl + kubeconfig）</option>
                            <option value="ssh">SSH 跳板机（在装有 kubectl 的主机上执行）</option>
                        </select>
                    </div>
                </div>
                <div class="form-row" id="kc-host-row" style="display:none">
                    <div class="form-item"><label>跳板主机</label><select class="select" id="kc-hostid" style="width:100%"></select></div>
                    <div class="form-item"><label>默认命名空间</label><input class="input mono" id="kc-ns" value="default"></div>
                </div>
                <div class="form-item"><label>备注</label><input class="input" id="kc-note"></div>
                <div class="toolbar" style="justify-content:flex-end">
                    <button class="btn btn-ghost btn-sm" id="kc-form-cancel" style="display:none">取消编辑</button>
                    <button class="btn btn-primary btn-sm" data-write id="kc-save">保存集群</button>
                </div>
            </div>
        </div>
    </div>

    <!-- 通用输出弹窗（日志 / 命令 / 镜像详情） -->
    <div class="modal-mask" id="dout-modal">
        <div class="modal" style="width:840px;max-width:94vw">
            <div class="modal-header"><h3 id="dout-title">输出</h3><button class="modal-close" data-close>×</button></div>
            <div class="modal-body">
                <div class="toolbar" id="dout-exec-row" style="display:none;margin-top:0">
                    <input class="input mono" id="dout-cmd" placeholder="容器内命令，如：df -h" style="flex:1">
                    <button class="btn btn-primary btn-sm" id="dout-run">执行</button>
                </div>
                <pre class="code-output" id="dout-body" style="max-height:440px">—</pre>
            </div>
            <div class="modal-footer"><button class="btn btn-ghost" data-close>关闭</button></div>
        </div>
    </div>`;
}

/* ==================================================================
 * Docker 逻辑
 * ================================================================== */

function paintHostSelect() {
    const sel = root.querySelector('#dh-select');
    sel.innerHTML = state.hosts.length
        ? state.hosts.map(h => `<option value="${esc(h.id)}" ${h.id === state.activeHostId ? 'selected' : ''}>${esc(h.name)}${h.kind === 'tcp' ? ` (${esc(h.host)})` : h.kind === 'ssh' ? ' (SSH)' : ''}</option>`).join('')
        : '<option value="">暂无端点，点击「端点管理」新增</option>';
    const h = activeHost();
    root.querySelector('#dh-caption').textContent = h
        ? `端点：${h.name} · ${h.kind === 'tcp' ? 'TCP ' + h.host + ':' + h.port : h.kind === 'ssh' ? 'SSH 桥接（复用主机凭据，无需开放 2375）' : '本机 socket'}`
        : '尚未配置端点';
}

function paintContainers() {
    const tbody = root.querySelector('#dc-tbody');
    tbody.innerHTML = state.containers.length ? state.containers.map(c => `
        <tr data-id="${esc(c.fullId || c.id)}" data-name="${esc(c.name)}">
            <td><strong class="mono">${esc(c.name)}</strong><br><span class="muted mono" style="font-size:11px">${esc(c.id)}</span></td>
            <td class="mono" style="font-size:12px">${esc(c.image)}</td>
            <td>${stateBadge(c.state)}<br><span class="muted" style="font-size:11px">${esc(c.status || '')}</span></td>
            <td class="mono" style="font-size:11.5px">${(c.ports || []).map(esc).join('<br>') || '<span class="muted">-</span>'}</td>
            <td>${c.project ? `<span class="badge purple">${esc(c.project)}</span>` : '<span class="muted">-</span>'}</td>
            <td style="white-space:nowrap">
                ${c.state === 'running'
        ? `<button class="btn-link" data-dact="stop" data-write>停止</button>
                   <button class="btn-link" data-dact="restart" data-write>重启</button>
                   <button class="btn-link" data-dact="exec" data-write>命令</button>`
        : `<button class="btn-link" data-dact="start" data-write>启动</button>`}
                <button class="btn-link" data-dact="logs">日志</button>
                <button class="btn-link danger" data-dact="remove" data-write>删除</button>
            </td>
        </tr>`).join('') : emptyRow(6, '暂无容器（或端点不可达）');
}

function paintStacks() {
    const box = root.querySelector('#ds-body');
    box.innerHTML = state.stacks.length ? state.stacks.map(s => `
        <div class="card" style="margin-bottom:10px;box-shadow:none;border:1px solid var(--border)">
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
                <tbody>${s.containers.map(c => `<tr><td class="mono">${esc(c.service || '-')}</td><td class="mono">${esc(c.name)}</td><td class="mono" style="font-size:12px">${esc(c.image)}</td><td>${stateBadge(c.state)}</td></tr>`).join('')}</tbody>
            </table></div>
        </div>`).join('') : '<div class="empty">当前端点上没有带 compose 标签的项目</div>';
}

function paintImages() {
    const tbody = root.querySelector('#di-tbody');
    tbody.innerHTML = state.images.length ? state.images.map(im => {
        const ref = (im.tags || [])[0] || im.id;
        return `
        <tr data-id="${esc(im.id)}">
            <td class="mono" style="font-size:12px">${(im.tags || []).map(esc).join('<br>') || '<span class="muted">&lt;none&gt;</span>'}</td>
            <td class="muted mono">${esc(im.id)}</td>
            <td>${fmtSize(im.size || 0)}</td>
            <td class="muted">${im.created ? new Date(im.created).toLocaleString() : '-'}</td>
            <td>
                <button class="btn-link" data-iact="detail" data-ref="${esc(ref)}">详情</button>
                <button class="btn-link danger" data-iact="del" data-write>删除</button>
            </td>
        </tr>`;
    }).join('') : emptyRow(5, '暂无镜像');
}

function paintComposeScripts() {
    const box = root.querySelector('#dcp-list');
    box.innerHTML = state.composeScripts.length ? state.composeScripts.map(s => `
        <div class="list-item" data-id="${esc(s.id)}">
            <div style="min-width:0"><div class="list-item-title">${esc(s.name)}</div><div class="list-item-sub">${esc(s.desc || '')}</div></div>
            <div class="list-item-actions"><button class="btn-link" data-act="load">载入</button></div>
        </div>`).join('') : '<div class="empty">脚本库中还没有 Compose 文件（脚本管理 → 新建 → Compose）</div>';
}

function paintDockerInfo() {
    const box = root.querySelector('#dc-info');
    const i = state.dockerInfo;
    if (!i) return;
    if (!i.ok) { box.innerHTML = `<span class="badge red">不可达</span> <span class="muted" style="font-size:12px">${esc(i.message)}</span>`; return; }
    box.innerHTML = `
        <span class="badge green">已连接</span>
        <span class="dc-kv">Docker <b>${esc(i.serverVersion || '?')}</b></span>
        <span class="dc-kv">OS <b>${esc(i.os || '?')}/${esc(i.arch || '?')}</b></span>
        <span class="dc-kv">内核 <b>${esc(i.kernel || '-')}</b></span>
        <span class="dc-kv">容器 <b>${esc(i.containersRunning || 0)}/${esc(i.containers || 0)} 运行</b></span>
        <span class="dc-kv">镜像 <b>${esc(i.images || 0)}</b></span>
        <span class="dc-kv">存储 <b>${esc(i.driver || '-')}</b></span>
        <span class="dc-kv">CPU <b>${esc(i.cpu || '-')} 核</b> · 内存 <b>${esc(i.memTotalMB || '-')} MB</b></span>
        ${i.composeVersion ? `<span class="dc-kv">compose <b>${esc(i.composeVersion)}</b></span>` : '<span class="badge amber">本机无 compose CLI</span>'}
        ${i.swarm ? `<span class="badge blue">Swarm: ${esc(i.swarm)}</span>` : ''}`;
}

async function loadDocker(silent) {
    if (!state.activeHostId) { state.containers = []; state.stacks = []; paintContainers(); paintStacks(); return; }
    const res = await api.docker.containers(state.activeHostId, state.showAll);
    if (res && res.ok) {
        state.containers = res.containers || [];
        state.stacks = res.stacks || [];
    } else if (!silent) {
        state.containers = []; state.stacks = [];
        toast((res && res.message) || '容器加载失败', 'danger');
    }
    paintContainers();
    paintStacks();
}

async function loadImages() {
    const res = await api.docker.images(state.activeHostId);
    state.images = (res && res.ok) ? (res.images || []) : [];
    if (res && !res.ok) toast(res.message, 'danger');
    paintImages();
}

async function showDockerInfo() {
    const box = root.querySelector('#dc-info');
    box.innerHTML = '<span class="muted" style="font-size:12px">读取引擎信息中…</span>';
    const res = await api.docker.info(state.activeHostId);
    state.dockerInfo = res || { ok: false, message: '无响应' };
    paintDockerInfo();
}

/* ==================================================================
 * K8s 逻辑
 * ================================================================== */

function paintClusterSelect() {
    const sel = root.querySelector('#kc-select');
    sel.innerHTML = state.clusters.length
        ? state.clusters.map(c => `<option value="${esc(c.id)}" ${c.id === state.activeClusterId ? 'selected' : ''}>${esc(c.name)}${c.mode === 'ssh' ? ' (SSH)' : ' (本机)'}</option>`).join('')
        : '<option value="">暂无集群，点击「集群管理」新增</option>';
    root.querySelector('#kc-term-card').style.display = canAdmin() ? '' : 'none';
}

function renderKubeBody(html) {
    root.querySelector('#kube-body').innerHTML = html;
}

async function refreshOverview() {
    if (!state.activeClusterId) { renderKubeBody('<div class="empty">请先配置 K8s 集群</div>'); return; }
    renderKubeBody('<div class="empty">概览加载中（kubectl 并行 5 类查询，SSH 模式约数秒）…</div>');
    const res = await api.kube.overview(state.activeClusterId);
    if (res && res.ok) {
        state.overview = res;
        state.overviewError = '';
        renderKubeBody(kubeOverviewHtml(res));
    } else {
        state.overview = null;
        state.overviewError = (res && res.message) || '概览加载失败';
        renderKubeBody(`<div class="alert danger"><span>${esc(state.overviewError)}</span></div>
            <div class="form-hint">排查提示：local 模式需平台机安装 kubectl 并配置 kubeconfig；远程集群请在「集群管理」选择 SSH 跳板主机（该主机需装有 kubectl 且能访问 API Server），并确认主机 SSH 凭据可用（凭据台账）。</div>`);
    }
}

async function quickQuery() {
    const resource = root.querySelector('#kq-res').value;
    const ns = root.querySelector('#kq-ns').value.trim();
    const body = root.querySelector('#kq-body');
    body.innerHTML = '<div class="empty">查询中…</div>';
    const res = await api.kube.get(state.activeClusterId, resource, ns ? { namespace: ns } : { allNamespaces: true });
    if (!res || !res.ok) { body.innerHTML = `<div class="alert danger"><span>${esc((res && res.message) || '查询失败')}</span></div>`; return; }
    const rows = res.rows || [];
    state.kubeRows = rows;
    body.innerHTML = `<div class="table-wrap" style="max-height:360px;overflow:auto"><table class="table">
        <thead><tr><th>命名空间</th><th>名称</th><th>就绪/状态</th><th>运行</th>${resource === 'pods' ? '<th>操作</th>' : ''}</tr></thead>
        <tbody>${rows.length ? rows.map(r => `<tr data-pod="${esc(r.name)}" data-ns="${esc(r.ns)}">
            <td class="muted">${esc(r.ns || '-')}</td>
            <td class="mono">${esc(r.name)}</td>
            <td>${stateBadge(r.ready || r.status || '')}</td>
            <td class="muted">${esc(r.age || '')}</td>
            ${resource === 'pods' ? `<td><button class="btn-link" data-klog="${esc(r.name)}" data-kns="${esc(r.ns)}">日志</button></td>` : ''}
        </tr>`).join('') : emptyRow(resource === 'pods' ? 5 : 4, '无数据')}</tbody>
    </table></div>`;
}

/* ==================================================================
 * 端点 / 集群管理
 * ================================================================== */

let editingHost = null;

function paintHostTable() {
    root.querySelector('#dh-tbody').innerHTML = state.hosts.length ? state.hosts.map(h => `
        <tr data-id="${esc(h.id)}">
            <td><strong>${esc(h.name)}</strong></td>
            <td>${h.kind === 'tcp' ? 'TCP' : h.kind === 'ssh' ? 'SSH 桥接' : '本机'}</td>
            <td class="mono" style="font-size:11.5px">${h.kind === 'tcp' ? esc(`${h.host}:${h.port}`) : h.kind === 'ssh' ? esc((state.hostOptions.find(x => x.id === h.hostId) || {}).name || h.hostId || '未关联') : 'socket'}</td>
            <td>${h.hasToken ? `<span class="muted">${esc(h.tokenMasked)}</span>` : '<span class="muted">-</span>'}</td>
            <td>
                <button class="btn-link" data-hact="edit">编辑</button>
                <button class="btn-link" data-hact="test">测试</button>
                <button class="btn-link danger" data-hact="del">删除</button>
            </td>
        </tr>`).join('') : '<tr><td colspan="5"><div class="empty">暂无端点</div></td></tr>';
}

function fillHostForm(h) {
    editingHost = h || null;
    const kind = h ? h.kind : 'pipe';
    root.querySelector('#dh-form-title').textContent = h ? `编辑端点 · ${h.name}` : '新增端点';
    root.querySelector('#dh-name').value = h ? h.name : '';
    root.querySelector('#dh-kind').value = kind;
    root.querySelector('#dh-host').value = h ? h.host || '' : '';
    root.querySelector('#dh-port').value = h ? h.port || '' : '2375';
    root.querySelector('#dh-token').value = '';
    root.querySelector('#dh-hostid').innerHTML = '<option value="">（选择主机）</option>'
        + state.hostOptions.map(x => `<option value="${esc(x.id)}" ${h && h.hostId === x.id ? 'selected' : ''}>${esc(x.name)} · ${esc(x.ip)}${x.hasPassword ? '' : '（无密码，建议先配置）'}</option>`).join('');
    root.querySelector('#dh-form-cancel').style.display = h ? '' : 'none';
    syncHostKindUi(kind);
}

function syncHostKindUi(kind) {
    root.querySelector('#dh-tcp-row').style.display = kind === 'tcp' ? '' : 'none';
    root.querySelector('#dh-ssh-row').style.display = kind === 'ssh' ? '' : 'none';
}

let editingCluster = null;

function paintKcTable() {
    root.querySelector('#kc-tbody').innerHTML = state.clusters.length ? state.clusters.map(c => `
        <tr data-id="${esc(c.id)}">
            <td><strong>${esc(c.name)}</strong></td>
            <td>${c.mode === 'ssh' ? 'SSH 跳板' : '本机 kubectl'}</td>
            <td class="muted">${esc((state.kubeHosts.find(h => h.id === c.hostId) || {}).name || '-')}</td>
            <td>${c.status === 'ok' ? '<span class="badge green">通</span>' : c.status === 'error' ? '<span class="badge red">断</span>' : '<span class="badge gray">未测</span>'}</td>
            <td>
                <button class="btn-link" data-cact="edit">编辑</button>
                <button class="btn-link danger" data-cact="del">删除</button>
            </td>
        </tr>`).join('') : '<tr><td colspan="5"><div class="empty">暂无集群</div></td></tr>';
}

function fillKcForm(c) {
    editingCluster = c || null;
    root.querySelector('#kc-form-title').textContent = c ? `编辑集群 · ${c.name}` : '新增集群';
    root.querySelector('#kc-name').value = c ? c.name : '';
    root.querySelector('#kc-mode').value = c ? c.mode : 'local';
    root.querySelector('#kc-hostid').innerHTML = '<option value="">（选择跳板主机）</option>'
        + state.kubeHosts.map(h => `<option value="${esc(h.id)}" ${c && c.hostId === h.id ? 'selected' : ''}>${esc(h.name)} · ${esc(h.ip)}</option>`).join('');
    root.querySelector('#kc-ns').value = c ? c.namespace || 'default' : 'default';
    root.querySelector('#kc-note').value = c ? c.note || '' : '';
    root.querySelector('#kc-form-cancel').style.display = c ? '' : 'none';
    root.querySelector('#kc-host-row').style.display = (c ? c.mode : 'local') === 'ssh' ? '' : 'none';
}

/* ==================================================================
 * 输出弹窗
 * ================================================================== */

function openOutput(title, text, execMode) {
    root.querySelector('#dout-title').textContent = title;
    root.querySelector('#dout-body').textContent = text || '—';
    root.querySelector('#dout-exec-row').style.display = execMode ? '' : 'none';
    root.querySelector('#dout-modal').classList.add('open');
}

/* ==================================================================
 * 挂载
 * ================================================================== */

export async function mount(r) {
    root = r;
    state.showAll = localStorage.getItem(SHOW_ALL_KEY) !== '0';
    state.engine = state.engine || 'docker';
    state.dockerInfo = null;

    /* ---- 数据加载 ---- */
    try {
        const [dh, ss] = await Promise.all([api.docker.hosts.list(), api.scripts.list()]);
        state.hosts = (dh && dh.endpoints) || [];
        state.hostOptions = (dh && dh.hosts) || [];
        state.kubeHosts = state.hostOptions;
        composeCache(ss);
    } catch (err) { state.hosts = []; state.composeScripts = []; }
    try {
        const kc = await api.kube.clusters();
        state.clusters = (kc && kc.clusters) || [];
        if (kc && kc.hosts && kc.hosts.length) state.kubeHosts = kc.hosts;
        state.activeClusterId = (state.clusters[0] || {}).id || null;
    } catch (err) { state.clusters = []; }
    try {
        const kr = await api.kube.resources();
        state.kubeResources = (kr && kr.resources) || [];
    } catch (err) { /* demo */ }

    state.activeHostId = (state.hosts.find(h => h.kind === 'pipe') || state.hosts[0] || {}).id || null;
    paintHostSelect();
    paintContainers();
    paintStacks();
    paintImages();
    paintComposeScripts();
    paintClusterSelect();
    root.querySelector('#kq-res').innerHTML = state.kubeResources.map(x => `<option value="${esc(x)}">${esc(x)}</option>`).join('') || '<option value="pods">pods</option>';

    /* ---- 引擎切换 ---- */
    root.querySelector('#eng-seg').addEventListener('click', e => {
        const btn = e.target.closest('.eng-btn');
        if (!btn) return;
        state.engine = btn.dataset.eng;
        root.querySelectorAll('.eng-btn').forEach(b => b.classList.toggle('active', b === btn));
        root.querySelectorAll('.eng-pane').forEach(p => { p.style.display = p.dataset.eng === state.engine ? '' : 'none'; });
    });

    /* ---- Docker：端点条 ---- */
    root.querySelector('#dh-select').addEventListener('change', e => {
        state.activeHostId = e.target.value;
        state.dockerInfo = null;
        root.querySelector('#dc-info').innerHTML = '<span class="muted" style="font-size:12.5px">点「测试」查看引擎状态</span>';
        loadDocker();
    });
    root.querySelector('#dh-test').addEventListener('click', async () => {
        if (!state.activeHostId) { toast('请先配置端点', 'warn'); return; }
        const res = await api.docker.hosts.test(state.activeHostId);
        toast(res && res.ok ? res.message : `连接失败：${(res && res.message) || ''}`, res && res.ok ? 'success' : 'danger');
        const local = state.hosts.find(h => h.id === state.activeHostId);
        if (local) { local.status = res && res.ok ? 'ok' : 'error'; }
        if (res && res.ok) { showDockerInfo(); await loadDocker(); }
    });
    root.querySelector('#dh-manage').addEventListener('click', () => {
        if (!guardAdmin('管理 Docker 端点')) return;
        fillHostForm(null); paintHostTable();
        root.querySelector('#dh-modal').classList.add('open');
    });
    root.querySelector('#dh-kind').addEventListener('change', e => syncHostKindUi(e.target.value));
    root.querySelector('#dh-form-cancel').addEventListener('click', () => fillHostForm(null));
    root.querySelector('#dh-save').addEventListener('click', async () => {
        if (!guardAdmin('保存 Docker 端点')) return;
        const name = root.querySelector('#dh-name').value.trim();
        if (!name) { toast('请填写端点名称', 'warn'); return; }
        const res = await api.docker.hosts.save({
            id: editingHost ? editingHost.id : undefined,
            name,
            kind: root.querySelector('#dh-kind').value,
            host: root.querySelector('#dh-host').value.trim(),
            port: root.querySelector('#dh-port').value.trim(),
            hostId: root.querySelector('#dh-hostid').value,
            token: root.querySelector('#dh-token').value
        });
        if (res && res.ok) {
            toast('端点已保存', 'success');
            await reloadEndpoints();
            const saved = state.hosts.find(h => h.id === (res.host || {}).id);
            if (saved) { state.activeHostId = saved.id; paintHostSelect(); loadDocker(); }
            paintHostTable(); fillHostForm(null);
        } else toast((res && res.message) || '保存失败', 'danger');
    });
    root.querySelector('#dh-tbody').addEventListener('click', async e => {
        const btn = e.target.closest('[data-hact]');
        if (!btn) return;
        const id = btn.closest('tr').dataset.id;
        const host = state.hosts.find(h => h.id === id);
        if (!host) return;
        if (btn.dataset.hact === 'edit') { fillHostForm(host); return; }
        if (btn.dataset.hact === 'test') {
            const res = await api.docker.hosts.test(id);
            toast(res && res.ok ? res.message : `连接失败：${(res && res.message) || ''}`, res && res.ok ? 'success' : 'danger');
            host.status = res && res.ok ? 'ok' : 'error';
            paintHostTable();
            return;
        }
        if (!guardAdmin('删除 Docker 端点')) return;
        if (!confirm(`删除端点「${host.name}」？`)) return;
        const res = await api.docker.hosts.remove(id);
        if (res && res.ok) {
            state.hosts = state.hosts.filter(h => h.id !== id);
            if (state.activeHostId === id) state.activeHostId = (state.hosts[0] || {}).id || null;
            paintHostSelect(); paintHostTable(); loadDocker();
        }
    });

    /* ---- Docker：页签与容器 ---- */
    root.querySelector('#dc-tabs').addEventListener('click', e => {
        const tab = e.target.closest('.tab');
        if (!tab) return;
        state.dockerTab = tab.dataset.tab;
        root.querySelectorAll('#dc-tabs .tab').forEach(t => t.classList.toggle('active', t === tab));
        root.querySelectorAll('#dc-panes .pane').forEach(p => { p.style.display = p.dataset.dtab === state.dockerTab ? '' : 'none'; });
        if (state.dockerTab === 'images' && !state.images.length) loadImages();
    });
    root.querySelector('#dc-all').addEventListener('change', e => {
        state.showAll = e.target.checked;
        localStorage.setItem(SHOW_ALL_KEY, state.showAll ? '1' : '0');
        loadDocker();
    });
    root.querySelector('#dc-refresh').addEventListener('click', () => loadDocker());
    root.querySelector('#di-refresh').addEventListener('click', loadImages);

    root.querySelector('#dc-tbody').addEventListener('click', async e => {
        const btn = e.target.closest('[data-dact]');
        if (!btn) return;
        const tr = btn.closest('tr');
        const { dact: act } = btn.dataset;
        const id = tr.dataset.id; const name = tr.dataset.name;
        if (act === 'logs') {
            openOutput(`日志 · ${name}`, '读取中...');
            const res = await api.docker.logs(state.activeHostId, id, 300);
            root.querySelector('#dout-body').textContent = (res && res.ok) ? res.text : ((res && res.message) || '读取失败');
        } else if (act === 'exec') {
            openOutput(`容器命令 · ${name}`, '输入命令后回车执行', true);
            root.querySelector('#dout-exec-row').dataset.target = id;
        } else {
            await dockerRun(act, id, name);
        }
    });

    root.querySelector('#ds-body').addEventListener('click', async e => {
        const btn = e.target.closest('[data-stack]');
        if (!btn) return;
        if (!guardWrite('项目级操作', 'containers')) return;
        const { stack: action, project } = btn.dataset;
        if ((action === 'stop' || action === 'restart') && !confirm(`确认${action === 'stop' ? '停止' : '重启'}项目「${project}」的全部容器？`)) return;
        const res = await api.docker.stackRun(state.activeHostId, project, action);
        toast(res && res.ok ? `项目 ${action} 完成` : ((res && res.message) || '操作失败'), res && res.ok ? 'success' : 'danger');
        if (res && res.ok) await loadDocker();
    });

    root.querySelector('#di-tbody').addEventListener('click', async e => {
        const btn = e.target.closest('[data-iact]');
        if (!btn) return;
        const tr = btn.closest('tr');
        if (btn.dataset.iact === 'detail') {
            openOutput(`镜像详情 · ${btn.dataset.ref}`, '读取中...');
            const res = await api.docker.imageDetail(state.activeHostId, btn.dataset.ref);
            if (res && res.ok) {
                const lines = [
                    `镜像：${(res.repoTags || []).join(', ') || res.id}`,
                    `大小：${fmtSize(res.size || 0)} · ${res.os || ''}/${res.architecture || ''} · 创建于 ${res.created || '-'}`,
                    `入口：${res.entrypoint || '-'} ${res.cmd || ''}`,
                    `用户：${res.user || '-'} · 工作目录：${res.workingDir || '-'}`,
                    `暴露端口：${(res.exposedPorts || []).join(', ') || '-'}`,
                    '', '── 分层历史（最新在前）──',
                    ...(res.history || []).map(h => `${fmtSize(h.size)}  ${h.createdBy}`)
                ];
                if (res.env && res.env.length) lines.push('', '── Env（前 40 条）──', ...res.env);
                root.querySelector('#dout-body').textContent = lines.join('\n');
            } else {
                root.querySelector('#dout-body').textContent = (res && res.message) || '读取失败';
            }
            return;
        }
        if (!guardAdmin('删除镜像')) return;
        const id = tr.dataset.id;
        if (!confirm(`删除镜像 ${id}？（被容器占用会失败）`)) return;
        const res = await api.docker.run(state.activeHostId, 'image-delete', id, false);
        toast(res && res.ok ? '镜像已删除' : ((res && res.message) || '删除失败'), res && res.ok ? 'success' : 'danger');
        if (res && res.ok) await loadImages();
    });

    /* Compose 文件 */
    root.querySelector('#dcp-list').addEventListener('click', async e => {
        const btn = e.target.closest('[data-act="load"]');
        if (!btn) return;
        const item = state.composeScripts.find(s => s.id === btn.closest('[data-id]').dataset.id);
        if (!item) return;
        const detail = await api.scripts.detail(item.id).catch(() => null);
        root.querySelector('#dcp-yaml').value = (detail && detail.content) || '';
    });
    const runCompose = async action => {
        if (!guardAdmin(`docker compose ${action}`)) return;
        const yaml = root.querySelector('#dcp-yaml').value;
        const msg = root.querySelector('#dcp-msg');
        const out = root.querySelector('#dcp-out');
        if (!yaml.trim()) { toast('请先填写或载入 compose 内容', 'warn'); return; }
        msg.textContent = `docker compose ${action} 执行中...`;
        const res = await api.docker.compose(yaml, action);
        msg.textContent = res && res.ok ? '执行成功' : ((res && res.message) || '执行失败');
        out.style.display = res && res.output ? '' : 'none';
        out.textContent = (res && res.output) || '';
        if (res && res.ok && action !== 'ps') await loadDocker();
    };
    root.querySelector('#dcp-up').addEventListener('click', () => runCompose('up'));
    root.querySelector('#dcp-down').addEventListener('click', () => runCompose('down'));
    root.querySelector('#dcp-ps').addEventListener('click', () => runCompose('ps'));

    /* ---- K8s ---- */
    root.querySelector('#kc-select').addEventListener('change', e => {
        state.activeClusterId = e.target.value;
        state.overview = null;
        renderKubeBody('<div class="empty">选择集群后点「刷新概览」</div>');
    });
    root.querySelector('#kc-refresh').addEventListener('click', refreshOverview);
    root.querySelector('#kc-test').addEventListener('click', async () => {
        if (!state.activeClusterId) { toast('请先配置集群', 'warn'); return; }
        const res = await api.kube.test(state.activeClusterId);
        toast(res && res.ok ? res.message : `连接失败：${(res && res.message) || ''}`, res && res.ok ? 'success' : 'danger');
    });
    root.querySelector('#kc-manage').addEventListener('click', () => {
        if (!guardAdmin('管理 K8s 集群')) return;
        fillKcForm(null); paintKcTable();
        root.querySelector('#kc-modal').classList.add('open');
    });
    root.querySelector('#kc-mode').addEventListener('change', e => {
        root.querySelector('#kc-host-row').style.display = e.target.value === 'ssh' ? '' : 'none';
    });
    root.querySelector('#kc-form-cancel').addEventListener('click', () => fillKcForm(null));
    root.querySelector('#kc-save').addEventListener('click', async () => {
        if (!guardAdmin('保存 K8s 集群')) return;
        const res = await api.kube.save({
            id: editingCluster ? editingCluster.id : undefined,
            name: root.querySelector('#kc-name').value,
            mode: root.querySelector('#kc-mode').value,
            hostId: root.querySelector('#kc-hostid').value,
            namespace: root.querySelector('#kc-ns').value,
            note: root.querySelector('#kc-note').value
        });
        if (res && res.ok) {
            toast('集群已保存', 'success');
            const list = await api.kube.clusters();
            state.clusters = (list && list.clusters) || [];
            state.activeClusterId = (res.cluster || {}).id || state.activeClusterId;
            paintClusterSelect(); paintKcTable(); fillKcForm(null);
        } else toast((res && res.message) || '保存失败', 'danger');
    });
    root.querySelector('#kc-tbody').addEventListener('click', async e => {
        const btn = e.target.closest('[data-cact]');
        if (!btn) return;
        const id = btn.closest('tr').dataset.id;
        const cluster = state.clusters.find(c => c.id === id);
        if (!cluster) return;
        if (btn.dataset.cact === 'edit') { fillKcForm(cluster); return; }
        if (!guardAdmin('删除 K8s 集群')) return;
        if (!confirm(`删除集群「${cluster.name}」？`)) return;
        const res = await api.kube.remove(id);
        if (res && res.ok) {
            state.clusters = state.clusters.filter(c => c.id !== id);
            if (state.activeClusterId === id) state.activeClusterId = (state.clusters[0] || {}).id || null;
            paintClusterSelect(); paintKcTable();
        }
    });
    root.querySelector('#kq-go').addEventListener('click', () => {
        if (!state.activeClusterId) { toast('请先配置集群', 'warn'); return; }
        quickQuery();
    });
    root.querySelector('#kq-body').addEventListener('click', async e => {
        const btn = e.target.closest('[data-klog]');
        if (!btn) return;
        openOutput(`Pod 日志 · ${btn.dataset.kns}/${btn.dataset.klog}`, '读取中...');
        const res = await api.kube.logs(state.activeClusterId, btn.dataset.klog, btn.dataset.kns, 300);
        root.querySelector('#dout-body').textContent = (res && res.ok) ? res.text : ((res && res.message) || '读取失败');
    });
    const ktRun = async () => {
        if (!guardAdmin('执行 kubectl')) return;
        const cmd = root.querySelector('#kt-cmd').value.trim();
        if (!cmd) return;
        const out = root.querySelector('#kt-out');
        out.style.display = '';
        out.textContent = '执行中...';
        const res = await api.kube.run(state.activeClusterId, cmd);
        out.textContent = (res && res.ok) ? res.text : ((res && (res.message || res.error)) || '执行失败');
    };
    root.querySelector('#kt-run').addEventListener('click', ktRun);
    root.querySelector('#kt-cmd').addEventListener('keydown', e => { if (e.key === 'Enter') ktRun(); });

    /* ---- 命令速查 ---- */
    root.addEventListener('click', e => {
        const copy = e.target.closest('[data-copy]');
        if (copy) {
            navigator.clipboard.writeText(copy.dataset.copy)
                .then(() => toast('命令已复制', 'success'), () => toast('复制失败', 'warn'));
            return;
        }
        const to = e.target.closest('[data-tokube]');
        if (to) {
            if (!canAdmin()) { toast('kubectl 终端仅管理员可用', 'warn'); return; }
            root.querySelector('#kt-cmd').value = to.dataset.tokube.replace(/^kubectl\s+/, '');
            state.engine = 'kube';
            root.querySelectorAll('.eng-btn').forEach(b => b.classList.toggle('active', b.dataset.eng === 'kube'));
            root.querySelectorAll('.eng-pane').forEach(p => { p.style.display = p.dataset.eng === 'kube' ? '' : 'none'; });
            root.querySelector('#kt-cmd').focus();
            toast('命令已送入 kubectl 终端（可修改后执行）', 'info');
        }
    });

    /* ---- 通用弹窗关闭 ---- */
    root.querySelectorAll('#dh-modal [data-close], #kc-modal [data-close], #dout-modal [data-close]').forEach(el =>
        el.addEventListener('click', () => {
            el.closest('.modal-mask').classList.remove('open');
        }));

    applyReadonly(root);

    /* 自动刷新（仅 Docker 容器页可见时） */
    if (state.timer) clearInterval(state.timer);
    state.timer = setInterval(() => {
        if (state.engine === 'docker' && state.dockerTab === 'containers' && state.activeHostId && !document.hidden) {
            loadDocker(true);
        }
    }, 10000);
}

function composeCache(scripts) {
    state.composeScripts = (Array.isArray(scripts) ? scripts : []).filter(s => s.type === 'compose')
        .map(s => ({ id: s.id, name: s.name, desc: s.desc || '' }));
}

async function reloadEndpoints() {
    const res = await api.docker.hosts.list();
    state.hosts = (res && res.endpoints) || [];
    state.hostOptions = (res && res.hosts) || state.hostOptions;
    state.kubeHosts = state.hostOptions;
    if (!state.hosts.some(h => h.id === state.activeHostId)) {
        state.activeHostId = (state.hosts.find(h => h.kind === 'pipe') || state.hosts[0] || {}).id || null;
    }
}

async function dockerRun(action, id, name) {
    if (!guardWrite(`容器 ${action}`, 'containers')) return;
    const verb = { start: '启动', stop: '停止', restart: '重启', remove: '删除' }[action] || action;
    if ((action === 'stop' || action === 'restart' || action === 'remove')
        && !confirm(`确认${verb}「${name}」？${action === 'remove' ? '（容器将被删除，数据卷保留）' : ''}`)) return;
    const res = await api.docker.run(state.activeHostId, action, id, action === 'remove');
    toast(res && res.ok ? `${verb}成功` : ((res && res.message) || `${verb}失败`), res && res.ok ? 'success' : 'danger');
    if (res && res.ok) await loadDocker();
}
