/**
 * Agent 工作台（D 线 · 三问布局，doc §6.6）
 *   1. 现在需要我吗？ —— attention 顶栏：问题 / 审批 / 回写失败，内联答复后工单自动恢复
 *   2. 系统在做对的事吗？ —— 路由模式 / worker slot 负载 / 收集器 / 候选 / 24h 计数
 *   3. 单个工单做了什么？ —— 工单账本表 + 详情抽屉（trigger → 研判 → 轨迹 → 报告 → 回写）
 * 附属：手动建单（档案选择 + scope 圈定）、契约自检框（与收集器共用校验器）、
 *       ITSM 回写配置（仅系统管理员）。
 * 实时性：订阅 agent:updated 推送去抖刷新；新 attention 弹 toast + 系统通知。
 * 权限：写操作 guardWrite('ai')；回写配置 guardAdmin；只读账号 applyReadonly。
 */
import { api } from '../api.js';
import { esc, toast, emptyRow, loadingRow, shortTime, guardWrite, guardAdmin, canAdmin, demoBanner, applyReadonly } from '../ui.js';

const STAGES = {
    'person/answer': { label: '待答复', badge: 'amber' },
    'person/review': { label: '待验收', badge: 'blue' },
    'person/blocked': { label: '受阻 · 等人', badge: 'amber' },
    'person/failed': { label: '失败 · 等人', badge: 'red' },
    'working/queued': { label: '排队中', badge: 'gray' },
    'working': { label: '执行中', badge: 'green' },
    'ended': { label: '已结束', badge: 'gray' }
};
const SEVERITY = {
    critical: { label: '紧急', badge: 'red' },
    high: { label: '高', badge: 'amber' },
    medium: { label: '中', badge: 'blue' },
    low: { label: '低', badge: 'gray' }
};
const TRIGGER_STATUS = {
    pending: { label: '待研判', badge: 'gray' },
    observed: { label: '已研判 · 演练', badge: 'blue' },
    ignored: { label: '研判不接单', badge: 'gray' },
    assess_failed: { label: '研判失败', badge: 'red' },
    accepted: { label: '已建单', badge: 'green' }
};
const REPORT_STATUS = {
    ready: { label: '完成待验收', badge: 'blue' },
    progress: { label: '阶段进展', badge: 'gray' },
    blocked: { label: '受阻', badge: 'amber' },
    failed: { label: '失败', badge: 'red' },
    dropped: { label: '放弃', badge: 'gray' }
};
const WB_STATUS = {
    none: { label: '未回写', badge: 'gray' },
    dryrun: { label: '演练记录', badge: 'blue' },
    pending: { label: '回写中', badge: 'amber' },
    sent: { label: '已回写', badge: 'green' },
    failed: { label: '回写失败', badge: 'red' }
};
const ATT_KIND = {
    question: { label: '需要回答', badge: 'amber' },
    approval: { label: '高危执行审批', badge: 'red' },
    writeback_failed: { label: '回写失败', badge: 'red' }
};

const badge = (map, key) => {
    const m = map[key] || { label: key || '-', badge: 'gray' };
    return `<span class="badge ${m.badge}">${esc(m.label)}</span>`;
};
const fmtTs = ts => {
    if (!ts) return '-';
    const d = new Date(ts);
    if (isNaN(d.getTime())) return '-';
    const p = n => String(n).padStart(2, '0');
    return `${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
};

let routerState = null;
let attention = [];
let tickets = [];
let triggers = [];
let collectors = [];
let profiles = [];
let hosts = [];
let dbs = [];
let writeback = null;
let stageFilter = '';
let triggerFilter = '';
let unsub = null;
let refreshTimer = null;
let knownAttention = null;   // null = 首次加载（只登记不通知）
let detailId = null;
let editingCollectorId = null;
let rootEl = null;

/* ------------------------------------------------------------------
 * 渲染骨架
 * ------------------------------------------------------------------ */

export function render() {
    return `
    ${demoBanner(api.demoMode)}

    <div class="card" id="ab-att-card">
        <div class="card-header">
            <div>
                <div class="card-title">现在需要我吗？ <span id="ab-att-count"></span></div>
                <div class="card-desc">worker 受阻提问 / 高危执行审批 / 回写失败统一入队；内联处理后工单自动恢复执行</div>
            </div>
            <button class="btn btn-ghost btn-sm" id="ab-notify-perm" style="display:none">开启系统通知</button>
        </div>
        <div id="ab-att-body"><div class="empty">加载中...</div></div>
    </div>

    <div class="card">
        <div class="card-header">
            <div>
                <div class="card-title">系统在做对的事吗？</div>
                <div class="card-desc">路由模式 · worker 负载 · 收集器与候选 · 24h 活动（巡检异常进「日志审计 → 告警」）</div>
            </div>
            <div class="toolbar" style="margin:0">
                <button class="btn btn-ghost btn-sm" id="ab-refresh">刷新</button>
                <button class="btn btn-primary btn-sm" data-write data-module="ai" id="ab-create">+ 手动建单</button>
            </div>
        </div>
        <div id="ab-health"><div class="empty">加载中...</div></div>
        <div class="grid-2" style="align-items:start;margin-top:14px">
            <div>
                <div class="toolbar" style="margin-bottom:8px">
                    <strong style="font-size:13px">收集器（自动发现）</strong>
                    <span class="muted" style="font-size:11.5px;margin-right:auto">script 输出须符合 sgops-tickets/1 契约</span>
                    <button class="btn btn-ghost btn-sm" data-write data-module="ai" id="ab-col-new">+ 新建</button>
                </div>
                <div class="table-wrap" style="max-height:300px;overflow:auto">
                    <table class="table">
                        <thead><tr><th>名称</th><th>模式</th><th>上次运行</th><th>下次</th><th style="width:150px">操作</th></tr></thead>
                        <tbody id="ab-col-body">${loadingRow(5)}</tbody>
                    </table>
                </div>
            </div>
            <div>
                <div class="toolbar" style="margin-bottom:8px">
                    <strong style="font-size:13px">候选（触发记录）</strong>
                    <select class="select" id="ab-trg-filter" style="width:150px;margin-left:auto">
                        <option value="">全部状态</option>
                        <option value="pending">待研判</option>
                        <option value="observed">已研判 · 演练</option>
                        <option value="ignored">研判不接单</option>
                        <option value="assess_failed">研判失败</option>
                        <option value="accepted">已建单</option>
                    </select>
                </div>
                <div class="table-wrap" style="max-height:300px;overflow:auto">
                    <table class="table">
                        <thead><tr><th>外部 ID</th><th>来源</th><th>标题</th><th>状态</th><th style="width:110px">操作</th></tr></thead>
                        <tbody id="ab-trg-body">${loadingRow(5)}</tbody>
                    </table>
                </div>
            </div>
        </div>
    </div>

    <div class="card">
        <div class="card-header">
            <div>
                <div class="card-title">工单账本</div>
                <div class="card-desc">内部派工账本（非工单产品）；结果经人工验收后回写外部 ITSM · 停止 = Mandate 撤回，永不自动复活</div>
            </div>
            <select class="select" id="ab-stage" style="width:170px">
                <option value="">全部阶段</option>
                ${Object.entries(STAGES).map(([k, v]) => `<option value="${k}">${v.label}</option>`).join('')}
            </select>
        </div>
        <div class="table-wrap" style="max-height:460px;overflow:auto">
            <table class="table">
                <thead><tr><th>标题</th><th>来源</th><th>级别</th><th>阶段</th><th>轮次</th><th>执行档案</th><th>回写</th><th>创建</th><th style="width:190px">操作</th></tr></thead>
                <tbody id="ab-tk-body">${loadingRow(9)}</tbody>
            </table>
        </div>
    </div>

    <div class="card">
        <div class="card-header">
            <div>
                <div class="card-title">契约自检（sgops-tickets/1）</div>
                <div class="card-desc">其它 AI 编写的爬虫脚本交付前，把 stdout 原样贴进来跑同一校验器；报错精确到条 / 字段</div>
            </div>
            <button class="btn btn-primary btn-sm" id="ab-contract-run">校验</button>
        </div>
        <textarea class="textarea code-input" id="ab-contract-input" rows="7" spellcheck="false"
            placeholder="===SGOPS_TICKETS_BEGIN===&#10;{ &quot;contract&quot;: &quot;sgops-tickets/1&quot;, &quot;source&quot;: &quot;...&quot;, &quot;items&quot;: [...] }&#10;===SGOPS_TICKETS_END==="></textarea>
        <div id="ab-contract-result" style="margin-top:10px"></div>
    </div>

    ${canAdmin() ? `
    <div class="card">
        <div class="card-header">
            <div>
                <div class="card-title">外部工单回写（ITSM）</div>
                <div class="card-desc">人工验收 ready 后调用外部工单系统 API 上传已解决记录；密码密文存储 · 已发送永不重发 · 路由演练模式下只记录 dry-run</div>
            </div>
            <label class="switch" title="启用后验收即回写">
                <input type="checkbox" id="wb-enabled">
                <span class="track"></span>
            </label>
        </div>
        <div class="form-row">
            <div class="form-item"><label>API 地址 *</label><input class="input" id="wb-baseurl" placeholder="http://localhost:5273"></div>
            <div class="form-item"><label>账号 *</label><input class="input" id="wb-username" placeholder="建议专用最小权限账号" autocomplete="off"></div>
            <div class="form-item"><label>密码</label><input class="input" id="wb-password" type="password" placeholder="留空保持不变" autocomplete="new-password"></div>
        </div>
        <div class="form-row">
            <div class="form-item"><label>租户 ID *</label><input class="input" id="wb-tenant" placeholder="登录后切换租户"></div>
            <div class="form-item"><label>工单类型</label><input class="input" id="wb-type" type="number" min="1" value="1"></div>
            <div class="form-item"><label>系统 ID（可选）</label><input class="input" id="wb-system" placeholder="system_id"></div>
        </div>
        <div class="toolbar" style="margin-top:10px">
            <span class="muted" id="wb-status" style="font-size:12px;margin-right:auto"></span>
            <button class="btn btn-primary" id="wb-save">保存回写配置</button>
        </div>
    </div>` : ''}

    <div class="modal-mask" id="ab-create-modal">
        <div class="modal">
            <div class="modal-header"><h3>手动建单（跳过研判直接派工）</h3><button class="modal-close" data-close>×</button></div>
            <div class="modal-body">
                <div class="form-item"><label>标题 *</label><input class="input" id="ab-c-title" maxlength="200" placeholder="如：app-server-01 磁盘清理"></div>
                <div class="form-item"><label>问题描述 *（作为外部数据包裹注入，不构成额外授权）</label>
                    <textarea class="textarea" id="ab-c-detail" rows="4" placeholder="现象 / 期望结果 / 已知线索"></textarea></div>
                <div class="form-row">
                    <div class="form-item"><label>级别</label>
                        <select class="select" id="ab-c-severity">
                            <option value="critical">紧急</option><option value="high">高</option>
                            <option value="medium" selected>中</option><option value="low">低</option>
                        </select></div>
                    <div class="form-item"><label>执行档案（工单级覆盖）</label><select class="select" id="ab-c-profile"></select></div>
                </div>
                <div class="form-item"><label>操作范围圈定（不勾 = 不限制该类；勾选后冻结，越界工具调用会被代码拒绝）</label>
                    <div class="grid-2">
                        <div class="ab-scope-box" id="ab-c-hosts"></div>
                        <div class="ab-scope-box" id="ab-c-dbs"></div>
                    </div>
                </div>
            </div>
            <div class="modal-footer">
                <span class="muted" style="font-size:12px;margin-right:auto">预算与高危审批沿用「AI 配置」中的 Agent 设置</span>
                <button class="btn btn-ghost" data-close>取消</button>
                <button class="btn btn-primary" id="ab-c-submit">建单并派工</button>
            </div>
        </div>
    </div>

    <div class="modal-mask" id="ab-col-modal">
        <div class="modal">
            <div class="modal-header"><h3 id="ab-col-modal-title">新建收集器</h3><button class="modal-close" data-close>×</button></div>
            <div class="modal-body">
                <div class="form-row">
                    <div class="form-item"><label>名称 *</label><input class="input" id="ab-cl-name" placeholder="如：Zabbix 告警拉取"></div>
                    <div class="form-item"><label>模式 *</label>
                        <select class="select" id="ab-cl-mode">
                            <option value="api">api：定时 GET 我的 API 拉增量</option>
                            <option value="script">script：定时执行本机爬虫脚本</option>
                        </select></div>
                    <div class="form-item"><label>启用</label>
                        <label class="switch" style="margin-top:6px"><input type="checkbox" id="ab-cl-enabled" checked><span class="track"></span></label></div>
                </div>
                <div class="form-item" id="ab-cl-url-row"><label>API 地址 *（http(s)://，响应映射为契约 items）</label>
                    <input class="input" id="ab-cl-url" placeholder="https://itsm.example.com/api/tickets?status=open"></div>
                <div class="form-item" id="ab-cl-token-row"><label>Bearer Token（密文存储，留空保持不变）</label>
                    <input class="input" id="ab-cl-token" type="password" autocomplete="new-password" placeholder="留空保持不变"></div>
                <div class="form-item" id="ab-cl-cursor-row"><label>增量游标参数名</label>
                    <input class="input" id="ab-cl-cursorparam" value="since" placeholder="since"></div>
                <div class="form-item" id="ab-cl-command-row" style="display:none"><label>脚本命令 *（经黑白名单校验 + 审计；stdout 须含契约帧）</label>
                    <textarea class="textarea code-input" id="ab-cl-command" rows="3" spellcheck="false" placeholder="node D:/crawlers/zabbix-tickets.js"></textarea></div>
                <div class="form-row">
                    <div class="form-item"><label>间隔（分钟）</label><input class="input" id="ab-cl-interval" type="number" min="1" value="60"></div>
                    <div class="form-item"><label>超时（秒）</label><input class="input" id="ab-cl-timeout" type="number" min="5" max="600" value="60"></div>
                </div>
            </div>
            <div class="modal-footer">
                <button class="btn btn-ghost" data-close>取消</button>
                <button class="btn btn-primary" id="ab-cl-submit">保存收集器</button>
            </div>
        </div>
    </div>

    <div class="modal-mask" id="ab-detail-modal">
        <div class="modal" style="max-width:860px;width:92%">
            <div class="modal-header"><h3 id="ab-detail-title">工单详情</h3><button class="modal-close" data-close>×</button></div>
            <div class="modal-body" id="ab-detail-body" style="max-height:70vh;overflow:auto"></div>
            <div class="modal-footer" id="ab-detail-footer"></div>
        </div>
    </div>`;
}

/* ------------------------------------------------------------------
 * 数据刷新
 * ------------------------------------------------------------------ */

async function refresh() {
    if (!rootEl) return;
    try {
        const [st, att, tk, trg, col, model, wb] = await Promise.all([
            api.ai.router.state(),
            api.ai.attention.list('open'),
            api.ai.tickets.list(),
            api.ai.triggers.list(),
            api.ai.collectors.list(),
            api.ai.model.get(),
            api.ai.writeback.get()
        ]);
        routerState = st && st.ok ? st : null;
        attention = (att && att.attention) || [];
        tickets = (tk && tk.tickets) || [];
        triggers = (trg && trg.triggers) || [];
        collectors = (col && col.collectors) || [];
        profiles = (model && model.profiles) || [];
        writeback = (wb && wb.writeback) || null;
        notifyNewAttention();
        paintAttention();
        paintHealth();
        paintCollectors();
        paintTriggers();
        paintTickets();
        paintWriteback();
        if (detailId) paintDetail(detailId);
    } catch (err) {
        toast('Agent 工作台刷新失败：' + err.message, 'danger');
    }
}

function scheduleRefresh() {
    clearTimeout(refreshTimer);
    refreshTimer = setTimeout(() => refresh(), 400);
}

/** 新 attention：toast + 系统通知（首次加载只登记，避免开机轰炸） */
function notifyNewAttention() {
    const ids = new Set(attention.map(a => a.id));
    if (knownAttention === null) { knownAttention = ids; return; }
    for (const a of attention) {
        if (knownAttention.has(a.id)) continue;
        const t = tickets.find(x => x.id === a.ticketId);
        const title = t ? t.title : a.ticketId;
        const kind = (ATT_KIND[a.kind] || {}).label || a.kind;
        toast(`Agent 待办（${kind}）：${title}`, 'warn');
        try {
            if (typeof Notification !== 'undefined' && Notification.permission === 'granted') {
                new Notification('SgOps · Agent 需要人工处理', { body: `【${kind}】${title}\n${String(a.question || '').slice(0, 120)}` });
            }
        } catch { /* 通知不可用不影响界面 */ }
    }
    knownAttention = ids;
}

/* ------------------------------------------------------------------
 * ① attention
 * ------------------------------------------------------------------ */

function paintAttention() {
    const body = rootEl.querySelector('#ab-att-body');
    const count = rootEl.querySelector('#ab-att-count');
    count.innerHTML = attention.length ? `<span class="badge amber">${attention.length} 项待处理</span>` : '';
    if (!attention.length) {
        body.innerHTML = '<div class="empty">暂无待办 —— worker 受阻提问 / 高危审批 / 回写失败会出现在这里</div>';
        return;
    }
    body.innerHTML = attention.map(a => {
        const t = tickets.find(x => x.id === a.ticketId);
        const kind = ATT_KIND[a.kind] || { label: a.kind, badge: 'gray' };
        const args = a.args ? `<pre class="ab-args">${esc(JSON.stringify(a.args, null, 2).slice(0, 1200))}</pre>` : '';
        let actions;
        if (a.kind === 'approval') {
            actions = `
                <button class="btn btn-primary btn-sm" data-write data-module="ai" data-att-approve="${esc(a.id)}">批准执行</button>
                <button class="btn btn-danger btn-sm" data-write data-module="ai" data-att-reject="${esc(a.id)}">拒绝</button>`;
        } else if (a.kind === 'writeback_failed') {
            actions = `<button class="btn btn-primary btn-sm" data-write data-module="ai" data-att-wbretry="${esc(a.id)}">重试回写</button>`;
        } else {
            actions = `
                <div class="ab-att-answer">
                    <textarea class="textarea" rows="2" data-att-text="${esc(a.id)}" placeholder="输入回答，worker 将带着它继续执行"></textarea>
                    <button class="btn btn-primary btn-sm" data-write data-module="ai" data-att-answer="${esc(a.id)}">回答并恢复</button>
                </div>`;
        }
        return `
        <div class="ab-att-item">
            <div class="ab-att-head">
                <span class="badge ${kind.badge}">${esc(kind.label)}</span>
                <strong>${esc(t ? t.title : a.ticketId)}</strong>
                <span class="muted" style="font-size:11.5px">${esc(shortTime(a.createdAt))}</span>
                <button class="btn btn-ghost btn-sm" style="margin-left:auto" data-tk-view="${esc(a.ticketId)}">查看工单</button>
            </div>
            <div class="ab-att-question">${esc(a.question || '')}</div>
            ${args}
            <div class="ab-att-actions">${actions}</div>
        </div>`;
    }).join('');
}

async function answerAttention(id, payload, okMsg) {
    if (!guardWrite('答复 Agent 待办', 'ai')) return;
    try {
        const res = await api.ai.attention.answer(id, payload);
        if (!res || !res.ok) { toast((res && res.message) || '答复失败', 'warn'); return; }
        toast(okMsg, 'success');
        refresh();
    } catch (err) {
        toast('答复失败：' + err.message, 'danger');
    }
}

/* ------------------------------------------------------------------
 * ② 健康 / slot / 收集器 / 候选
 * ------------------------------------------------------------------ */

function paintHealth() {
    const el = rootEl.querySelector('#ab-health');
    if (!routerState) { el.innerHTML = '<div class="empty">路由状态读取失败</div>'; return; }
    const s = routerState;
    const modeBadge = !s.agentEnabled
        ? '<span class="badge gray">Agent 总开关关闭</span>'
        : s.routerMode === 'active'
            ? '<span class="badge green">路由启用 · 自动派工</span>'
            : '<span class="badge blue">路由演练 · 只研判不派工</span>';
    const execBadge = { approve: '<span class="badge amber">高危审批</span>', observe: '<span class="badge blue">高危演练</span>', auto: '<span class="badge red">高危免审</span>' }[s.execMode] || '';
    const c = s.counts24h || {};
    const slots = (s.slots || []).map(sl => `
        <div class="ab-slot">
            <div class="ab-slot-head"><span class="badge green">忙碌</span><strong>${esc(sl.title || sl.ticketId)}</strong></div>
            <div class="muted" style="font-size:11.5px">档案：${esc(sl.profileName || '-')} · 已用 ${sl.rounds || 0} 轮 · 始于 ${fmtTs(sl.startedAt)}</div>
            <button class="btn btn-ghost btn-sm" data-tk-view="${esc(sl.ticketId)}">查看</button>
        </div>`).join('');
    const idle = Math.max(0, (s.capacity || 0) - (s.slots || []).length);
    el.innerHTML = `
    <div class="ab-health-top">
        ${modeBadge} ${execBadge}
        <span class="muted" style="font-size:12px">工作槽 ${((s.slots || []).length)}/${s.capacity || 0}（另保留 1 个给人工建单）</span>
        <span class="muted" style="font-size:12px;margin-left:auto">24h：接单 ${c.created || 0} · 待验收 ${c.ready || 0} · 受阻 ${c.blocked || 0} · 失败 ${c.failed || 0} · 结束 ${c.ended || 0} · 待研判候选 ${s.triggersPending || 0}</span>
    </div>
    <div class="ab-slot-row">
        ${slots || ''}
        ${Array.from({ length: idle }, () => '<div class="ab-slot idle"><span class="badge gray">空闲</span><span class="muted" style="font-size:12px">等待派工</span></div>').join('')}
    </div>`;
}

function paintCollectors() {
    const body = rootEl.querySelector('#ab-col-body');
    if (!collectors.length) { body.innerHTML = emptyRow(5, '暂无收集器：新建 api / script 收集器开始自动发现'); return; }
    body.innerHTML = collectors.map(c => {
        const status = c.lastStatus === 'success' ? '<span class="badge green">成功</span>'
            : c.lastStatus ? `<span class="badge red">${esc(c.lastStatus)}</span>` : '<span class="badge gray">未运行</span>';
        return `<tr>
            <td><strong>${esc(c.name)}</strong>${c.enabled ? '' : ' <span class="badge gray">停用</span>'}
                <div class="muted" style="font-size:11px">${c.mode === 'api' ? esc(c.url) : esc(c.command)}</div>
                ${c.failStreak ? `<div class="muted" style="font-size:11px;color:var(--danger)">连续失败 ${c.failStreak} 次${c.lastError ? '：' + esc(c.lastError.slice(0, 80)) : ''}</div>` : ''}</td>
            <td><span class="badge ${c.mode === 'api' ? 'blue' : 'purple'}">${esc(c.mode)}</span><div class="muted" style="font-size:11px">每 ${c.intervalMinutes} 分钟</div></td>
            <td>${status}<div class="muted" style="font-size:11px">${esc(shortTime(c.lastRunAt))}</div></td>
            <td class="muted" style="font-size:11.5px">${c.enabled ? fmtTs(c.nextRunAt) : '-'}</td>
            <td>
                <button class="btn btn-ghost btn-sm" data-write data-module="ai" data-col-run="${esc(c.id)}">运行</button>
                <button class="btn btn-ghost btn-sm" data-write data-module="ai" data-col-edit="${esc(c.id)}">编辑</button>
                <button class="btn btn-ghost btn-sm" data-write data-module="ai" data-col-del="${esc(c.id)}">删除</button>
            </td>
        </tr>`;
    }).join('');
}

function paintTriggers() {
    const body = rootEl.querySelector('#ab-trg-body');
    const list = triggers.filter(t => !triggerFilter || t.status === triggerFilter);
    if (!list.length) { body.innerHTML = emptyRow(5, '暂无候选'); return; }
    body.innerHTML = list.map(t => {
        const p = t.payload || {};
        const canAccept = !t.ticketId && ['observed', 'ignored', 'assess_failed', 'pending'].includes(t.status);
        return `<tr>
            <td class="mono" style="font-size:11.5px">${esc(t.externalId)}</td>
            <td>${esc(t.source)}</td>
            <td><strong>${esc(p.title || '-')}</strong>
                ${t.assessment && t.assessment.reason ? `<div class="muted" style="font-size:11px">研判：${esc(t.assessment.reason)}</div>` : ''}</td>
            <td>${badge(TRIGGER_STATUS, t.status)}<div class="muted" style="font-size:11px">${esc(shortTime(t.createdAt))}</div></td>
            <td>${canAccept ? `<button class="btn btn-ghost btn-sm" data-write data-module="ai" data-trg-accept="${esc(t.id)}">采纳建单</button>` : (t.ticketId ? `<button class="btn btn-ghost btn-sm" data-tk-view="${esc(t.ticketId)}">查看工单</button>` : '-')}</td>
        </tr>`;
    }).join('');
}

/* ------------------------------------------------------------------
 * ③ 工单账本 + 详情
 * ------------------------------------------------------------------ */

const profileNameOf = t => {
    if (t.assignment && t.assignment.profileName) return t.assignment.profileName;
    const p = profiles.find(x => x.id === t.profileId);
    return p ? p.name : (t.profileId || '跟随默认');
};

function ticketActions(t) {
    const btns = [`<button class="btn btn-ghost btn-sm" data-tk-view="${esc(t.id)}">详情</button>`];
    if (t.status !== 'ended') {
        if (t.stage === 'person/review') btns.push(`<button class="btn btn-primary btn-sm" data-write data-module="ai" data-tk-accept="${esc(t.id)}">验收</button>`);
        if (['person/failed', 'person/blocked'].includes(t.stage)) btns.push(`<button class="btn btn-ghost btn-sm" data-write data-module="ai" data-tk-retry="${esc(t.id)}">重试</button>`);
        btns.push(`<button class="btn btn-danger btn-sm" data-write data-module="ai" data-tk-stop="${esc(t.id)}">停止</button>`);
    }
    return btns.join(' ');
}

function paintTickets() {
    const body = rootEl.querySelector('#ab-tk-body');
    const list = tickets.filter(t => !stageFilter || t.stage === stageFilter);
    if (!list.length) { body.innerHTML = emptyRow(9, '暂无工单：自动接单或手动建单后出现在这里'); return; }
    body.innerHTML = list.map(t => `<tr>
        <td><strong>${esc(t.title)}</strong>${t.manual ? ' <span class="badge purple">人工</span>' : ''}</td>
        <td class="muted" style="font-size:11.5px">${esc(t.source)}${t.externalId ? `<div class="mono" style="font-size:11px">${esc(t.externalId)}</div>` : ''}</td>
        <td>${badge(SEVERITY, t.severity)}</td>
        <td>${badge(STAGES, t.stage)}</td>
        <td class="muted" style="font-size:12px">${t.roundsUsed || 0}/${(t.budget || {}).maxRounds || '-'}</td>
        <td class="muted" style="font-size:11.5px">${esc(profileNameOf(t))}</td>
        <td>${badge(WB_STATUS, (t.writeback || {}).status)}${(t.writeback || {}).ticketNo ? `<div class="mono" style="font-size:11px">${esc(t.writeback.ticketNo)}</div>` : ''}</td>
        <td class="muted" style="font-size:11.5px">${esc(shortTime(t.createdAt))}</td>
        <td>${ticketActions(t)}</td>
    </tr>`).join('');
}

const scopeText = scope => {
    if (!scope) return '未圈定（受工具 gate 与黑白名单约束）';
    const parts = [];
    if (scope.hostIds && scope.hostIds.length) {
        parts.push('主机：' + scope.hostIds.map(id => { const h = hosts.find(x => x.id === id); return h ? h.name : id; }).join('、'));
    }
    if (scope.dbIds && scope.dbIds.length) {
        parts.push('数据源：' + scope.dbIds.map(id => { const d = dbs.find(x => x.id === id); return d ? d.name : id; }).join('、'));
    }
    return parts.join('；') || '空';
};

function detailHtml(t) {
    const sec = (title, inner) => `<div class="ab-detail-sec"><div class="ab-detail-sec-title">${title}</div>${inner}</div>`;
    const trigger = triggers.find(x => x.id === t.triggerId);
    const reports = (t.reports || []).map(r => `
        <div class="ab-report">
            ${badge(REPORT_STATUS, r.status)} <span class="muted" style="font-size:11px">${esc(shortTime(r.at))}</span>
            <div style="margin-top:4px">${esc(r.summary || '')}</div>
            ${r.question ? `<div class="muted" style="font-size:12px;margin-top:2px">提问：${esc(r.question)}</div>` : ''}
            ${r.evidence ? `<div class="muted" style="font-size:12px;margin-top:2px">证据：${esc(r.evidence)}</div>` : ''}
        </div>`).join('') || '<div class="muted" style="font-size:12px">暂无报告</div>';
    const trace = (t.trace || []).length ? `
        <div class="table-wrap" style="max-height:220px;overflow:auto"><table class="table">
            <thead><tr><th style="width:50px">轮</th><th style="width:170px">工具</th><th>摘要</th><th style="width:110px">时间</th></tr></thead>
            <tbody>${t.trace.map(s => `<tr><td>${s.round}</td><td class="mono" style="font-size:11.5px">${esc(s.name)}</td><td style="font-size:12px">${esc(s.summary)}</td><td class="muted" style="font-size:11px">${esc(shortTime(s.at))}</td></tr>`).join('')}</tbody>
        </table></div>` : '<div class="muted" style="font-size:12px">暂无工具轨迹</div>';
    const dialog = (t.dialog || []).map(m => `
        <div class="ab-dialog ${m.role === 'user' ? 'user' : 'assistant'}">
            <span class="badge ${m.role === 'user' ? 'blue' : 'green'}">${m.role === 'user' ? '输入 / 人工' : 'worker'}</span>
            <pre>${esc(String(m.content || '').slice(0, 4000))}</pre>
        </div>`).join('');
    const wb = t.writeback || { status: 'none' };
    const a = t.assignment;
    return `
    <div class="ab-detail-meta">
        ${badge(STAGES, t.stage)} ${badge(SEVERITY, t.severity)} ${badge(WB_STATUS, wb.status)}
        ${t.status === 'ended' ? `<span class="badge gray">处置：${esc(t.disposition || '-')}</span>` : ''}
        <span class="muted" style="font-size:12px">来源 ${esc(t.source)}${t.externalId ? ' · 外部 ID ' + esc(t.externalId) : ''} · 创建 ${esc(shortTime(t.createdAt))}${t.endedAt ? ' · 结束 ' + esc(shortTime(t.endedAt)) : ''}</span>
    </div>
    ${sec('范围与预算（接单时冻结，扩权 = 新工单）', `
        <div class="ab-kv"><span>操作范围</span><div>${esc(scopeText(t.scope))}</div></div>
        <div class="ab-kv"><span>预算</span><div>已用 ${t.roundsUsed || 0}/${(t.budget || {}).maxRounds || '-'} 轮 · 时限 ${(t.budget || {}).maxMinutes || '-'} 分钟</div></div>
        <div class="ab-kv"><span>执行档案</span><div>${esc(profileNameOf(t))}${a ? ` · slot ${esc(a.slotId)} · 启动 ${fmtTs(a.startedAt)}${a.active ? '' : '（已结束）'}` : ' · 尚未派工'}</div></div>`)}
    ${wb.status !== 'none' ? sec('外部工单回写', `
        <div class="ab-kv"><span>状态</span><div>${badge(WB_STATUS, wb.status)}${wb.ticketNo ? ` 外部工单号 <strong class="mono">${esc(wb.ticketNo)}</strong>` : ''}${wb.ticketId ? ` · id ${esc(wb.ticketId)}` : ''} · 尝试 ${wb.attempts || 0} 次</div></div>
        ${wb.lastError ? `<div class="alert danger" style="margin-top:6px"><span>${esc(wb.lastError)}</span></div>` : ''}`) : ''}
    ${t.assessment ? sec('接单研判（只读评估，不构成额外授权）', `
        <div class="ab-kv"><span>结论</span><div>${t.assessment.accept ? '<span class="badge green">接单</span>' : '<span class="badge gray">不接单</span>'} ${esc(t.assessment.reason || '')}</div></div>
        ${t.assessment.suggestedScope ? `<div class="ab-kv"><span>建议范围</span><div class="mono" style="font-size:11.5px">${esc(JSON.stringify(t.assessment.suggestedScope))}</div></div>` : ''}`) : ''}
    ${trigger ? sec('触发候选原文（不可信外部数据）', `<pre class="ab-args">${esc(JSON.stringify(trigger.payload, null, 2).slice(0, 3000))}</pre>`) : ''}
    ${sec(`报告序列（${(t.reports || []).length}）`, reports)}
    ${sec(`工具轨迹（${(t.trace || []).length}）`, trace)}
    ${sec(`上下文对话（${(t.dialog || []).length}）`, `<div class="ab-dialog-list">${dialog}</div>`)}`;
}

async function paintDetail(id) {
    try {
        const res = await api.ai.tickets.get(id);
        if (!res || !res.ok || !res.ticket) {
            detailId = null;
            rootEl.querySelector('#ab-detail-modal').classList.remove('open');
            return;
        }
        const t = res.ticket;
        rootEl.querySelector('#ab-detail-title').textContent = t.title;
        rootEl.querySelector('#ab-detail-body').innerHTML = detailHtml(t);
        rootEl.querySelector('#ab-detail-footer').innerHTML =
            `<span class="muted" style="font-size:12px;margin-right:auto">${esc(t.id)}</span>` + ticketActions(t);
    } catch (err) {
        toast('工单详情加载失败：' + err.message, 'danger');
    }
}

function openDetail(id) {
    detailId = id;
    rootEl.querySelector('#ab-detail-modal').classList.add('open');
    rootEl.querySelector('#ab-detail-body').innerHTML = '<div class="empty">加载中...</div>';
    paintDetail(id);
}

/* ------------------------------------------------------------------
 * 工单操作
 * ------------------------------------------------------------------ */

async function ticketOp(kind, id) {
    const t = tickets.find(x => x.id === id);
    const title = t ? t.title : id;
    if (kind === 'accept') {
        if (!guardWrite('验收 Agent 工单', 'ai')) return;
        const wbOn = writeback && writeback.enabled;
        if (!confirm(wbOn ? `验收「${title}」并回写到外部工单系统？` : `确认验收「${title}」？验收后工单结束。`)) return;
    } else if (kind === 'stop') {
        if (!guardWrite('停止 Agent 工单', 'ai')) return;
        if (!confirm(`停止「${title}」？\n人工停止 = Mandate 撤回：永不自动复活，再工作需新接单。`)) return;
    } else if (kind === 'retry') {
        if (!guardWrite('重试 Agent 工单', 'ai')) return;
    }
    try {
        const res = await api.ai.tickets[kind](id);
        if (!res || !res.ok) { toast((res && res.message) || '操作失败', 'warn'); return; }
        if (kind === 'accept') {
            const wb = res.writeback || {};
            toast(wb.status === 'sent' ? `已验收并回写：外部工单 ${wb.ticketNo || wb.ticketId || ''}`
                : wb.status === 'failed' ? '已验收，但回写失败：请在待办中重试回写'
                : wb.status === 'dryrun' ? '已验收（路由演练模式：回写仅记录 dry-run）'
                : '已验收，工单结束', wb.status === 'failed' ? 'warn' : 'success');
        } else {
            toast(kind === 'stop' ? '工单已停止（不会自动复活）' : '已重新排队派工', 'success');
        }
        refresh();
    } catch (err) {
        toast('操作失败：' + err.message, 'danger');
    }
}

/* ------------------------------------------------------------------
 * 手动建单 / 收集器编辑
 * ------------------------------------------------------------------ */

function openCreate() {
    if (!guardWrite('手动建单', 'ai')) return;
    const m = rootEl.querySelector('#ab-create-modal');
    rootEl.querySelector('#ab-c-title').value = '';
    rootEl.querySelector('#ab-c-detail').value = '';
    rootEl.querySelector('#ab-c-severity').value = 'medium';
    rootEl.querySelector('#ab-c-profile').innerHTML = '<option value="">跟随执行档案默认</option>' +
        profiles.map(p => `<option value="${esc(p.id)}">${esc(p.name)}（${esc(p.model)}）</option>`).join('');
    const box = (items, kind) => items.length
        ? items.map(x => `<label class="check-item"><input type="checkbox" data-scope="${kind}" value="${esc(x.id)}"><div><strong>${esc(x.name)}</strong><span class="muted" style="font-size:11px;display:block">${esc(x.ip || x.host || x.type || '')}</span></div></label>`).join('')
        : '<div class="muted" style="font-size:12px">暂无可选项</div>';
    rootEl.querySelector('#ab-c-hosts').innerHTML = box(hosts, 'host');
    rootEl.querySelector('#ab-c-dbs').innerHTML = box(dbs, 'db');
    m.classList.add('open');
}

async function submitCreate() {
    if (!guardWrite('手动建单', 'ai')) return;
    const title = rootEl.querySelector('#ab-c-title').value.trim();
    const detail = rootEl.querySelector('#ab-c-detail').value.trim();
    if (!title || !detail) { toast('标题与问题描述必填', 'warn'); return; }
    const pick = kind => [...rootEl.querySelectorAll(`[data-scope="${kind}"]:checked`)].map(x => x.value);
    const hostIds = pick('host'), dbIds = pick('db');
    const payload = {
        title, detail,
        severity: rootEl.querySelector('#ab-c-severity').value,
        profileId: rootEl.querySelector('#ab-c-profile').value,
        scope: (hostIds.length || dbIds.length) ? { hostIds, dbIds } : null
    };
    try {
        const res = await api.ai.tickets.create(payload);
        if (!res || !res.ok) { toast((res && res.message) || '建单失败', 'warn'); return; }
        rootEl.querySelector('#ab-create-modal').classList.remove('open');
        toast('已建单并派工', 'success');
        refresh();
    } catch (err) {
        toast('建单失败：' + err.message, 'danger');
    }
}

function paintCollectorMode() {
    const mode = rootEl.querySelector('#ab-cl-mode').value;
    rootEl.querySelector('#ab-cl-url-row').style.display = mode === 'api' ? '' : 'none';
    rootEl.querySelector('#ab-cl-token-row').style.display = mode === 'api' ? '' : 'none';
    rootEl.querySelector('#ab-cl-cursor-row').style.display = mode === 'api' ? '' : 'none';
    rootEl.querySelector('#ab-cl-command-row').style.display = mode === 'script' ? '' : 'none';
}

function openCollector(id) {
    if (!guardWrite('维护收集器', 'ai')) return;
    editingCollectorId = id || null;
    const c = id ? collectors.find(x => x.id === id) : null;
    rootEl.querySelector('#ab-col-modal-title').textContent = c ? `编辑收集器「${c.name}」` : '新建收集器';
    rootEl.querySelector('#ab-cl-name').value = c ? c.name : '';
    rootEl.querySelector('#ab-cl-mode').value = c ? c.mode : 'api';
    rootEl.querySelector('#ab-cl-enabled').checked = c ? !!c.enabled : true;
    rootEl.querySelector('#ab-cl-url').value = c ? c.url : '';
    rootEl.querySelector('#ab-cl-token').value = '';
    rootEl.querySelector('#ab-cl-token').placeholder = c && c.hasToken ? '已保存（留空保持不变）' : '可选';
    rootEl.querySelector('#ab-cl-cursorparam').value = c ? (c.cursorParam || 'since') : 'since';
    rootEl.querySelector('#ab-cl-command').value = c ? c.command : '';
    rootEl.querySelector('#ab-cl-interval').value = c ? c.intervalMinutes : 60;
    rootEl.querySelector('#ab-cl-timeout').value = c ? c.timeout : 60;
    paintCollectorMode();
    rootEl.querySelector('#ab-col-modal').classList.add('open');
}

async function submitCollector() {
    if (!guardWrite('维护收集器', 'ai')) return;
    const payload = {
        id: editingCollectorId || undefined,
        name: rootEl.querySelector('#ab-cl-name').value.trim(),
        mode: rootEl.querySelector('#ab-cl-mode').value,
        enabled: rootEl.querySelector('#ab-cl-enabled').checked,
        url: rootEl.querySelector('#ab-cl-url').value.trim(),
        token: rootEl.querySelector('#ab-cl-token').value,
        cursorParam: rootEl.querySelector('#ab-cl-cursorparam').value.trim() || 'since',
        command: rootEl.querySelector('#ab-cl-command').value.trim(),
        intervalMinutes: Number(rootEl.querySelector('#ab-cl-interval').value) || 60,
        timeout: Number(rootEl.querySelector('#ab-cl-timeout').value) || 60
    };
    try {
        const res = await api.ai.collectors.save(payload);
        if (!res || !res.ok) { toast((res && res.message) || '保存失败', 'warn'); return; }
        rootEl.querySelector('#ab-col-modal').classList.remove('open');
        toast('收集器已保存', 'success');
        refresh();
    } catch (err) {
        toast('保存失败：' + err.message, 'danger');
    }
}

async function collectorOp(kind, id) {
    const c = collectors.find(x => x.id === id);
    if (kind === 'del') {
        if (!guardWrite('删除收集器', 'ai')) return;
        if (!confirm(`删除收集器「${c ? c.name : id}」？已入库候选不受影响。`)) return;
    } else if (!guardWrite('运行收集器', 'ai')) return;
    try {
        const res = kind === 'del' ? await api.ai.collectors.remove(id)
            : kind === 'run' ? await api.ai.collectors.run(id) : null;
        if (!res || !res.ok) { toast((res && res.message) || '操作失败', 'warn'); return; }
        if (kind === 'run') toast(`收集完成：新增 ${res.added || 0} · 去重跳过 ${res.skipped || 0}`, 'success');
        else toast('收集器已删除', 'success');
        refresh();
    } catch (err) {
        toast('操作失败：' + err.message, 'danger');
    }
}

/* ------------------------------------------------------------------
 * 契约自检 / 回写配置
 * ------------------------------------------------------------------ */

async function runContractCheck() {
    const text = rootEl.querySelector('#ab-contract-input').value;
    const out = rootEl.querySelector('#ab-contract-result');
    if (!text.trim()) { toast('请先粘贴脚本 stdout', 'warn'); return; }
    out.innerHTML = '<div class="muted" style="font-size:12px">校验中...</div>';
    try {
        const res = await api.ai.contractValidate(text);
        if (!res || !res.ok) { out.innerHTML = `<div class="alert danger"><span>${esc((res && res.message) || '校验失败')}</span></div>`; return; }
        if (res.valid) {
            out.innerHTML = `<div class="alert success"><span>契约校验通过：${(res.items || []).length} 条候选（items 为空 = 无新发现，同样合法）</span></div>`;
        } else {
            out.innerHTML = `<div class="alert danger"><span>契约校验未通过（${(res.errors || []).length} 处）——不入库</span></div>
                <div class="table-wrap" style="margin-top:8px;max-height:220px;overflow:auto"><table class="table">
                    <thead><tr><th style="width:220px">位置</th><th>原因</th></tr></thead>
                    <tbody>${(res.errors || []).map(e => `<tr><td class="mono" style="font-size:11.5px">${esc(e.path)}</td><td style="font-size:12px">${esc(e.reason)}</td></tr>`).join('')}</tbody>
                </table></div>`;
        }
    } catch (err) {
        out.innerHTML = `<div class="alert danger"><span>${esc(err.message)}</span></div>`;
    }
}

function paintWriteback() {
    const enabledEl = rootEl.querySelector('#wb-enabled');
    if (!enabledEl || !writeback) return;
    enabledEl.checked = !!writeback.enabled;
    rootEl.querySelector('#wb-baseurl').value = writeback.baseUrl || '';
    rootEl.querySelector('#wb-username').value = writeback.username || '';
    rootEl.querySelector('#wb-password').placeholder = writeback.hasPassword ? '已保存（留空保持不变）' : '必填';
    rootEl.querySelector('#wb-tenant').value = writeback.tenantId || '';
    rootEl.querySelector('#wb-type').value = writeback.ticketType || 1;
    rootEl.querySelector('#wb-system').value = writeback.systemId || '';
    rootEl.querySelector('#wb-status').textContent = writeback.enabled
        ? `回写已启用 → ${writeback.baseUrl}（租户 ${writeback.tenantId}）`
        : '回写未启用：验收后工单直接结束，不调用外部 API';
}

async function saveWriteback() {
    if (!guardAdmin('保存回写配置', 'ai')) return;
    const payload = {
        enabled: rootEl.querySelector('#wb-enabled').checked,
        baseUrl: rootEl.querySelector('#wb-baseurl').value.trim(),
        username: rootEl.querySelector('#wb-username').value.trim(),
        password: rootEl.querySelector('#wb-password').value,
        tenantId: rootEl.querySelector('#wb-tenant').value.trim(),
        ticketType: Number(rootEl.querySelector('#wb-type').value) || 1,
        systemId: rootEl.querySelector('#wb-system').value.trim()
    };
    try {
        const res = await api.ai.writeback.save(payload);
        if (!res || !res.ok) { toast((res && res.message) || '保存失败', 'warn'); return; }
        toast('回写配置已保存', 'success');
        refresh();
    } catch (err) {
        toast('保存失败：' + err.message, 'danger');
    }
}

/* ------------------------------------------------------------------
 * mount
 * ------------------------------------------------------------------ */

export async function mount(root) {
    rootEl = root;
    knownAttention = null;
    detailId = null;
    const $ = sel => root.querySelector(sel);

    /* 弹窗通用关闭 */
    root.querySelectorAll('.modal-mask').forEach(mask => {
        mask.addEventListener('click', e => {
            if (e.target === mask || e.target.closest('[data-close]')) {
                mask.classList.remove('open');
                if (mask.id === 'ab-detail-modal') detailId = null;
            }
        });
    });

    /* 动态按钮统一委托 */
    root.addEventListener('click', e => {
        const el = e.target.closest('[data-att-answer],[data-att-approve],[data-att-reject],[data-att-wbretry],[data-tk-view],[data-tk-accept],[data-tk-retry],[data-tk-stop],[data-trg-accept],[data-col-run],[data-col-edit],[data-col-del]');
        if (!el) return;
        const d = el.dataset;
        if (d.attAnswer !== undefined) {
            const ta = root.querySelector(`[data-att-text="${d.attAnswer}"]`);
            const text = ta ? ta.value.trim() : '';
            if (!text) { toast('回答内容不能为空', 'warn'); return; }
            answerAttention(d.attAnswer, { text }, '已答复，工单恢复执行');
        } else if (d.attApprove !== undefined) {
            answerAttention(d.attApprove, { approved: true }, '已批准执行');
        } else if (d.attReject !== undefined) {
            if (!confirm('拒绝该高危执行？worker 将按拒绝继续处理。')) return;
            answerAttention(d.attReject, { approved: false }, '已拒绝执行');
        } else if (d.attWbretry !== undefined) {
            answerAttention(d.attWbretry, { text: '重试回写' }, '已触发回写重试');
        } else if (d.tkView !== undefined) {
            openDetail(d.tkView);
        } else if (d.tkAccept !== undefined) {
            ticketOp('accept', d.tkAccept);
        } else if (d.tkRetry !== undefined) {
            ticketOp('retry', d.tkRetry);
        } else if (d.tkStop !== undefined) {
            ticketOp('stop', d.tkStop);
        } else if (d.trgAccept !== undefined) {
            (async () => {
                if (!guardWrite('采纳候选建单', 'ai')) return;
                try {
                    const res = await api.ai.triggers.accept(d.trgAccept);
                    if (!res || !res.ok) { toast((res && res.message) || '采纳失败', 'warn'); return; }
                    toast('已采纳建单并派工', 'success');
                    refresh();
                } catch (err) { toast('采纳失败：' + err.message, 'danger'); }
            })();
        } else if (d.colRun !== undefined) {
            collectorOp('run', d.colRun);
        } else if (d.colEdit !== undefined) {
            openCollector(d.colEdit);
        } else if (d.colDel !== undefined) {
            collectorOp('del', d.colDel);
        }
    });

    $('#ab-refresh').addEventListener('click', () => refresh());
    $('#ab-create').addEventListener('click', openCreate);
    $('#ab-c-submit').addEventListener('click', submitCreate);
    $('#ab-col-new').addEventListener('click', () => openCollector(null));
    $('#ab-cl-mode').addEventListener('change', paintCollectorMode);
    $('#ab-cl-submit').addEventListener('click', submitCollector);
    $('#ab-stage').addEventListener('change', e => { stageFilter = e.target.value; paintTickets(); });
    $('#ab-trg-filter').addEventListener('change', e => { triggerFilter = e.target.value; paintTriggers(); });
    $('#ab-contract-run').addEventListener('click', runContractCheck);
    const wbSave = $('#wb-save');
    if (wbSave) wbSave.addEventListener('click', saveWriteback);

    /* 系统通知授权（需用户手势） */
    const notifyBtn = $('#ab-notify-perm');
    if (typeof Notification !== 'undefined' && Notification.permission === 'default') {
        notifyBtn.style.display = '';
        notifyBtn.addEventListener('click', async () => {
            try {
                const p = await Notification.requestPermission();
                notifyBtn.style.display = p === 'granted' ? 'none' : '';
                toast(p === 'granted' ? '系统通知已开启' : '未授权系统通知（界面内待办照常提示）', p === 'granted' ? 'success' : 'info');
            } catch { /* 忽略 */ }
        });
    }

    /* 实时推送（重复 mount 先退订） */
    if (unsub) unsub();
    unsub = api.onAgentUpdated(() => scheduleRefresh());

    /* 静态资源：主机 / 数据源（建单圈定用） */
    try {
        const [h, d] = await Promise.all([api.hosts.list(), api.dbConfig.list()]);
        hosts = Array.isArray(h) ? h : (h && h.hosts) || [];
        dbs = Array.isArray(d) ? d : (d && d.sources) || [];
    } catch { /* 圈定列表为空不阻塞页面 */ }

    applyReadonly(root);
    await refresh();
}