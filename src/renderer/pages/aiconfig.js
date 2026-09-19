/**
 * AI 配置（独立页面 · 系统运维域）
 *
 * 承载两块能力：
 *   1. 模型配置：提供方（含主流模型清单）+ 接口地址 + 模型 + API Key + 连接测试
 *   2. Agent 能力：总开关、工具轮次、行数上限，以及各工具的启用状态
 *
 * 权限：页面随 ai 模块可见；模型 / Agent 的写入通道为管理员专属，
 *      只读账号在此页看到的是禁用态 + 明确提示（页面级 applyReadonly + guardAdmin）。
 */
import { api } from '../api.js';
import { esc, toast, guardAdmin, applyReadonly, canAdmin } from '../ui.js';

const RISK_BADGE = {
    '只读': 'gray',
    '低危': 'blue',
    '中危': 'amber',
    '高危': 'red'
};

/** Agent 开关项：(字段, 标题, 说明, 是否高危) */
const AGENT_TOGGLES = [
    { key: 'allowDataGenerate', title: 'generate_data · 生成测试数据', desc: '按字段定义合成 json / csv / sql 测试数据，数据只在本机生成不外发', danger: false },
    { key: 'allowSaveScript', title: 'save_script · 保存为脚本', desc: '把 AI 产出的 Shell / Python 脚本落库到「脚本管理」，同名自动升版本', danger: false },
    { key: 'allowLocalExec', title: 'run_local_command · 执行本机命令', desc: '在平台所在机器执行命令，仍需通过敏感词黑白名单校验并留痕；仅在受控环境开启', danger: true },
    { key: 'allowRemoteExec', title: 'run_host_command · 远程主机执行命令', desc: '在纳管主机（SSH）上执行单条命令，同样过黑白名单并审计；开启前建议先白名单演练', danger: true },
    { key: 'allowSqlExecute', title: 'execute_sql / describe_table · 查询数据源', desc: '在已配置数据源上执行只读 SQL 与查看表结构（SELECT / SHOW / DESC / EXPLAIN）', danger: true }
];

export function render() {
    return `
    <div class="card">
        <div class="card-header">
            <div>
                <div class="card-title">模型接入</div>
                <div class="card-desc">选择提供方自动带出地址与推荐模型 · API Key 加密存储，保存后仅掩码显示</div>
            </div>
            <span class="badge blue" id="ai-provider-current" style="display:none"></span>
        </div>
        <div class="grid-2" style="align-items:start">
            <div>
                <div class="muted" style="font-size:12px;margin-bottom:8px">提供方（点击卡片切换，点模型名填入表单）</div>
                <div class="ai-provider-grid" id="ai-provider-grid">
                    <div class="muted" style="font-size:12.5px">加载中...</div>
                </div>
            </div>
            <div>
                <div class="form-row">
                    <div class="form-item">
                        <label>提供方</label>
                        <select class="select" id="ai-provider"></select>
                    </div>
                    <div class="form-item">
                        <label>接口地址</label>
                        <input class="input mono" id="ai-baseurl" placeholder="https://api.deepseek.com">
                    </div>
                </div>
                <div class="form-row">
                    <div class="form-item">
                        <label>模型名称</label>
                        <input class="input mono" id="ai-model" placeholder="deepseek-chat" list="ai-model-list">
                        <datalist id="ai-model-list"></datalist>
                    </div>
                    <div class="form-item">
                        <label>API Key（留空表示不修改）</label>
                        <input class="input" id="ai-key" type="password" placeholder="sk-..." autocomplete="off">
                    </div>
                </div>
                <div class="toolbar" style="margin-top:10px">
                    <span class="muted" id="ai-config-status" style="font-size:12px;margin-right:auto"></span>
                    <button class="btn btn-ghost" id="ai-test" data-write>测试连接</button>
                    <button class="btn btn-primary" id="ai-save-config" data-write>保存配置</button>
                </div>
            </div>
        </div>
    </div>

    <div class="card">
        <div class="card-header">
            <div>
                <div class="card-title">Agent 能力与工具</div>
                <div class="card-desc">开启后 AI 可调用平台工具自动完成任务；右侧工具清单实时反映开关组合的生效状态</div>
            </div>
            <div class="toolbar" style="margin:0">
                <label class="switch" title="总开关：关闭时 AI 工作台不显示 Agent 开关">
                    <input type="checkbox" id="ag-enabled">
                    <span class="track"></span>
                </label>
                <span class="muted" style="font-size:12.5px">Agent 总开关</span>
            </div>
        </div>
        <div class="grid-2" style="align-items:start">
            <div>
                <div class="form-row" style="margin-bottom:2px">
                    <div class="form-item">
                        <label>最大工具轮次</label>
                        <input class="input" id="ag-steps" type="number" min="1" max="12" value="6">
                    </div>
                    <div class="form-item">
                        <label>命令超时（秒）</label>
                        <input class="input" id="ag-timeout" type="number" min="1" max="120" value="15">
                    </div>
                    <div class="form-item">
                        <label>数据行上限</label>
                        <input class="input" id="ag-rows" type="number" min="10" max="2000" value="200">
                    </div>
                </div>
                <div class="ag-toggle-grid" style="grid-template-columns:1fr">
                    ${AGENT_TOGGLES.map(t => `
                    <label class="check-item ${t.danger ? 'danger' : ''}" data-key="${esc(t.key)}">
                        <input type="checkbox" id="ag-${esc(t.key)}">
                        <div>
                            <strong>${esc(t.title)}</strong>
                            <span class="muted" style="font-size:11.5px;line-height:1.6;display:block;margin-top:2px">${esc(t.desc)}</span>
                        </div>
                    </label>`).join('')}
                </div>
                <div class="alert warn" style="margin-top:12px">
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg>
                    <span>本机命令执行与数据源查询属高危能力：即使开启，仍会经过命令黑白名单校验与只读 SQL 校验，并全部写入审计日志。生产环境建议保持关闭。</span>
                </div>
                <div class="toolbar" style="margin-top:12px">
                    <span class="muted" id="ag-status" style="font-size:12px;margin-right:auto"></span>
                    <button class="btn btn-primary" id="ag-save" data-write>保存 Agent 配置</button>
                </div>
            </div>
            <div>
                <div class="muted" style="font-size:12px;margin-bottom:8px">工具清单（受控开关随左侧组合实时变化）</div>
                <div class="table-wrap">
                    <table class="table">
                        <thead><tr><th>工具</th><th>风险</th><th>状态</th></tr></thead>
                        <tbody id="ag-tool-body"><tr><td colspan="3"><div class="empty">加载中...</div></td></tr></tbody>
                    </table>
                </div>
            </div>
        </div>
    </div>

    <div class="card">
        <div class="card-header">
            <div>
                <div class="card-title">提示词角色</div>
                <div class="card-desc">为 AI 工作台预置不同专业视角的系统提示词；内置角色可修改不可删除，自定义角色可增删</div>
            </div>
            <button class="btn btn-primary btn-sm" data-write id="ar-new">+ 新建角色</button>
        </div>
        <div class="grid-2" style="align-items:start">
            <div class="table-wrap" style="max-height:420px;overflow:auto">
                <table class="table">
                    <thead><tr><th>角色</th><th>类型</th><th style="width:130px">操作</th></tr></thead>
                    <tbody id="ar-tbody"><tr><td colspan="3"><div class="empty">加载中...</div></td></tr></tbody>
                </table>
            </div>
            <div>
                <div class="form-row">
                    <div class="form-item"><label>角色名称 *</label><input class="input" id="ar-name" placeholder="如：网络工程师"></div>
                    <div class="form-item"><label>一句话说明</label><input class="input" id="ar-desc" placeholder="出现在下拉与清单"></div>
                </div>
                <div class="form-item">
                    <label>系统提示词 *（作为 system 消息注入每次对话，只影响回答风格，不改变权限）</label>
                    <textarea class="textarea code-input" id="ar-prompt" rows="12" spellcheck="false"
                        placeholder="你是……&#10;专长：&#10;1. ……&#10;2. ……"></textarea>
                    <div class="form-hint" id="ar-editing">新建角色</div>
                </div>
                <div class="toolbar" style="justify-content:flex-end">
                    <button class="btn btn-ghost btn-sm" id="ar-cancel" style="display:none">取消编辑</button>
                    <button class="btn btn-primary" data-write id="ar-save">保存角色</button>
                </div>
            </div>
        </div>
    </div>`;
}

export async function mount(root) {
    const $ = sel => root.querySelector(sel);
    const statusEl = $('#ai-config-status');
    const agStatusEl = $('#ag-status');
    const providerSel = $('#ai-provider');
    const providerGrid = $('#ai-provider-grid');
    const modelList = $('#ai-model-list');
    const currentBadge = $('#ai-provider-current');

    let providers = [];
    let agentCfg = null;
    let tools = [];
    let hasKey = false;

    /* ---------------- 提供方卡片 ---------------- */

    function paintProviders(currentProvider, currentModel) {
        providerGrid.innerHTML = providers.map(p => {
            const models = [...new Set([].concat(p.models || [], p.model ? [p.model] : []).filter(Boolean))];
            const active = p.id === currentProvider;
            return `
            <div class="ai-provider-card ${active ? 'active' : ''}" data-provider="${esc(p.id)}">
                <div class="ai-provider-head">
                    <strong>${esc(p.label)}</strong>
                    ${active ? '<span class="badge blue">当前</span>' : ''}
                </div>
                <div class="ai-provider-url mono">${esc(p.baseURL || '自定义地址')}</div>
                <div class="ai-provider-models">
                    ${models.length
                    ? models.map(m => `<button class="ai-model-chip ${m === currentModel ? 'active' : ''}" data-model="${esc(m)}">${esc(m)}</button>`).join('')
                    : '<span class="muted" style="font-size:11.5px">无预设模型，请手动填写模型名</span>'}
                </div>
            </div>`;
        }).join('');

        providerGrid.querySelectorAll('.ai-provider-card').forEach(card =>
            card.addEventListener('click', e => {
                const chip = e.target.closest('.ai-model-chip');
                if (chip) {
                    $('#ai-model').value = chip.dataset.model;
                    toast(`已填入模型 ${chip.dataset.model}，保存后生效`, 'info');
                    return;
                }
                applyProvider(card.dataset.provider);
            }));
    }

    function fillModelOptions(providerId) {
        const p = providers.find(x => x.id === providerId) || {};
        const models = [...new Set([].concat(p.models || [], p.model ? [p.model] : []).filter(Boolean))];
        modelList.innerHTML = models.map(m => `<option value="${esc(m)}">`).join('');
    }

    /** 切换提供方：自动带出该家的默认地址与推荐模型 */
    function applyProvider(providerId) {
        const p = providers.find(x => x.id === providerId);
        if (!p) return;
        providerSel.value = providerId;
        if (p.baseURL) $('#ai-baseurl').value = p.baseURL;
        fillModelOptions(providerId);
        if (p.model) $('#ai-model').value = p.model;
        paintProviders(providerId, $('#ai-model').value);
        if (currentBadge) {
            currentBadge.style.display = '';
            currentBadge.textContent = `当前：${p.label}`;
        }
    }

    /* ---------------- Agent 表单 ---------------- */

    function paintAgent() {
        if (!agentCfg) return;
        $('#ag-enabled').checked = !!agentCfg.enabled;
        $('#ag-steps').value = agentCfg.maxSteps;
        $('#ag-timeout').value = agentCfg.commandTimeout;
        $('#ag-rows').value = agentCfg.maxRows;
        AGENT_TOGGLES.forEach(t => {
            const el = $(`#ag-${t.key}`);
            if (el) el.checked = !!agentCfg[t.key];
        });
        paintTools();
    }

    function paintTools() {
        const body = $('#ag-tool-body');
        if (!tools.length) {
            body.innerHTML = '<tr><td colspan="3"><div class="empty">暂无工具</div></td></tr>';
            return;
        }
        const globalOn = !!agentCfg.enabled;
        body.innerHTML = tools.map(t => {
            const enabled = !t.gate || !!agentCfg[t.gate];
            return `<tr>
                <td>
                    <strong>${esc(t.label)}</strong>
                    <span class="mono muted" style="font-size:11px"> · ${esc(t.name)}</span>
                    <div class="muted" style="font-size:11.5px;line-height:1.55">${esc(t.desc)}${t.gate ? ` · 受控于 ${esc(t.gate)}` : ' · 常开'}</div>
                </td>
                <td><span class="badge ${RISK_BADGE[t.risk] || 'gray'}">${esc(t.risk)}</span></td>
                <td>${enabled
                    ? (globalOn ? '<span class="badge green">可用</span>' : '<span class="badge gray">待总开关</span>')
                    : '<span class="badge gray">未开启</span>'}</td>
            </tr>`;
        }).join('');
    }

    function collectAgentPayload() {
        const num = (sel, fallback) => {
            const v = Number($(sel).value);
            return Number.isFinite(v) ? v : fallback;
        };
        const payload = {
            enabled: $('#ag-enabled').checked,
            maxSteps: num('#ag-steps', 6),
            commandTimeout: num('#ag-timeout', 15),
            maxRows: num('#ag-rows', 200)
        };
        AGENT_TOGGLES.forEach(t => { payload[t.key] = $(`#ag-${t.key}`).checked; });
        return payload;
    }

    /* ---------------- 数据加载 ---------------- */

    async function loadConfig() {
        try {
            const res = await api.ai.config.get();
            if (!res || !res.ok) { statusEl.textContent = '配置读取失败'; return; }
            const cfg = res.config || {};
            providers = cfg.providers || [];
            hasKey = !!cfg.hasKey;

            providerSel.innerHTML = providers.map(p =>
                `<option value="${esc(p.id)}"${p.id === cfg.provider ? ' selected' : ''}>${esc(p.label)}</option>`).join('');
            $('#ai-baseurl').value = cfg.baseURL || '';
            $('#ai-model').value = cfg.model || '';
            $('#ai-key').value = '';
            fillModelOptions(cfg.provider);
            paintProviders(cfg.provider, cfg.model);

            if (currentBadge) {
                currentBadge.style.display = '';
                currentBadge.textContent = `当前：${(providers.find(p => p.id === cfg.provider) || {}).label || cfg.provider}`;
            }
            statusEl.textContent = cfg.hasKey
                ? `已配置 API Key（掩码显示） · ${cfg.provider} · ${cfg.model}`
                : '尚未配置 API Key，AI 对话 / 脚本功能暂不可用';
        } catch (err) {
            statusEl.textContent = '配置读取失败：' + err.message;
        }
    }

    async function loadAgent() {
        try {
            const res = await api.ai.agent.tools();
            if (!res || !res.ok) { agStatusEl.textContent = 'Agent 配置读取失败'; return; }
            agentCfg = res.catalog || {};
            tools = res.tools || [];
            paintAgent();
            const highRisk = (tools.some(t => t.gate === 'allowLocalExec' && agentCfg.allowLocalExec) ||
                tools.some(t => t.gate === 'allowSqlExecute' && agentCfg.allowSqlExecute));
            agStatusEl.textContent = agentCfg.enabled
                ? `Agent 已启用 · 开放 ${tools.filter(t => !t.gate || agentCfg[t.gate]).length}/${tools.length} 个工具${highRisk ? ' · 含高危能力' : ''}`
                : 'Agent 总开关为关闭状态，AI 工作台不提供 Agent 开关';
        } catch (err) {
            agStatusEl.textContent = 'Agent 配置读取失败：' + err.message;
        }
    }

    /* ---------------- 事件绑定 ---------------- */

    providerSel.addEventListener('change', () => applyProvider(providerSel.value));

    $('#ai-test').addEventListener('click', async () => {
        if (!guardAdmin('测试 AI 连接')) return;
        const btn = $('#ai-test');
        const old = btn.textContent;
        btn.disabled = true; btn.textContent = '测试中...';
        statusEl.textContent = '正在测试连接...';
        try {
            const res = await api.ai.test($('#ai-model').value.trim());
            statusEl.textContent = res.message || (res.ok ? '连接成功' : '连接失败');
            toast(res && res.ok ? '连接成功' : `连接失败：${(res && res.message) || ''}`, res && res.ok ? 'success' : 'danger');
        } catch (err) {
            statusEl.textContent = '测试失败：' + err.message;
            toast('测试失败', 'danger');
        } finally {
            btn.disabled = false; btn.textContent = old;
        }
    });

    $('#ai-save-config').addEventListener('click', async () => {
        if (!guardAdmin('保存 AI 配置')) return;
        const btn = $('#ai-save-config');
        btn.disabled = true;
        try {
            const res = await api.ai.config.save({
                provider: providerSel.value,
                baseURL: $('#ai-baseurl').value.trim(),
                model: $('#ai-model').value.trim(),
                apiKey: $('#ai-key').value
            });
            if (res && res.ok) {
                toast('AI 模型配置已保存', 'success');
                await loadConfig();
            } else {
                toast((res && res.message) || '保存失败', 'danger');
                statusEl.textContent = (res && res.message) || '保存失败';
            }
        } catch (err) {
            toast('保存失败：' + err.message, 'danger');
        } finally {
            btn.disabled = false;
        }
    });

    $('#ag-enabled').addEventListener('change', () => {
        if (!agentCfg) return;
        agentCfg.enabled = $('#ag-enabled').checked;
        paintTools();
    });

    AGENT_TOGGLES.forEach(t => {
        const el = $(`#ag-${t.key}`);
        if (!el) return;
        el.addEventListener('change', () => {
            if (!agentCfg) return;
            agentCfg[t.key] = el.checked;
            paintTools();
        });
    });

    $('#ag-save').addEventListener('click', async () => {
        if (!guardAdmin('保存 Agent 配置')) return;
        const btn = $('#ag-save');
        btn.disabled = true;
        try {
            const res = await api.ai.agent.save(collectAgentPayload());
            if (res && res.ok) {
                agentCfg = res.agent;
                paintAgent();
                toast('Agent 配置已保存', 'success');
                agStatusEl.textContent = agentCfg.enabled
                    ? `Agent 已启用 · 开放 ${tools.filter(t => !t.gate || agentCfg[t.gate]).length}/${tools.length} 个工具`
                    : 'Agent 总开关为关闭状态';
            } else {
                toast((res && res.message) || '保存失败', 'danger');
            }
        } catch (err) {
            toast('保存失败：' + err.message, 'danger');
        } finally {
            btn.disabled = false;
        }
    });

    /* ---------------- 提示词角色 ---------------- */

    let roleList = [];
    let editingRole = null;

    function paintRoles() {
        const tbody = $('#ar-tbody');
        tbody.innerHTML = roleList.length ? roleList.map(r => `
            <tr data-id="${esc(r.id)}">
                <td>
                    <strong>${esc(r.name)}</strong>
                    <div class="muted" style="font-size:11.5px">${esc(r.desc || '')}</div>
                </td>
                <td>${r.builtin ? '<span class="badge purple">内置</span>' : '<span class="badge gray">自定义</span>'}</td>
                <td>
                    <button class="btn-link" data-ract="edit">编辑</button>
                    ${r.builtin ? '' : '<button class="btn-link danger" data-ract="del">删除</button>'}
                </td>
            </tr>`).join('') : '<tr><td colspan="3"><div class="empty">暂无角色</div></td></tr>';
    }

    function fillRoleForm(role) {
        editingRole = role || null;
        $('#ar-editing').textContent = role
            ? `编辑：${role.name}${role.builtin ? '（内置角色，保存即覆盖预设提示词）' : ''}`
            : '新建角色';
        $('#ar-name').value = role ? role.name : '';
        $('#ar-desc').value = role ? role.desc : '';
        $('#ar-prompt').value = role ? role.prompt : '';
        $('#ar-cancel').style.display = role ? '' : 'none';
    }

    async function loadRoles() {
        try {
            const res = await api.ai.roles.list();
            roleList = (res && res.roles) || [];
        } catch (err) { roleList = []; }
        paintRoles();
    }

    $('#ar-new').addEventListener('click', () => {
        if (!guardAdmin('新建提示词角色')) return;
        fillRoleForm(null);
        $('#ar-name').focus();
    });
    $('#ar-cancel').addEventListener('click', () => fillRoleForm(null));
    $('#ar-tbody').addEventListener('click', async e => {
        const btn = e.target.closest('[data-ract]');
        if (!btn) return;
        const id = btn.closest('tr').dataset.id;
        const role = roleList.find(r => r.id === id);
        if (!role) return;
        if (btn.dataset.ract === 'edit') {
            if (!guardAdmin('编辑提示词角色')) return;
            fillRoleForm(role);
            return;
        }
        if (!guardAdmin('删除提示词角色')) return;
        if (!confirm(`删除角色「${role.name}」？使用该角色的用户将回落到默认助手`)) return;
        const res = await api.ai.roles.remove(id);
        if (res && res.ok) {
            toast('角色已删除', 'success');
            if (editingRole && editingRole.id === id) fillRoleForm(null);
            await loadRoles();
        } else toast((res && res.message) || '删除失败', 'danger');
    });
    $('#ar-save').addEventListener('click', async () => {
        if (!guardAdmin('保存提示词角色')) return;
        const res = await api.ai.roles.save({
            id: editingRole ? editingRole.id : undefined,
            name: $('#ar-name').value,
            desc: $('#ar-desc').value,
            prompt: $('#ar-prompt').value
        });
        if (res && res.ok) {
            toast('角色已保存，AI 工作台角色下拉即时可见', 'success');
            fillRoleForm(null);
            await loadRoles();
        } else {
            toast((res && res.message) || '保存失败', 'danger');
        }
    });

    await Promise.all([loadConfig(), loadAgent(), loadRoles()]);
    applyReadonly(root);

    // 非管理员（含只读角色）只可查看：锁掉全部表单控件，避免「能点能输但保存被拒」
    if (!canAdmin()) {
        root.querySelectorAll('input, select, button').forEach(el => {
            el.disabled = true;
            el.style.cursor = 'not-allowed';
        });
        const hint = '当前账号非系统管理员，AI 模型与 Agent 配置仅可查看';
        $(`#ai-test`).title = hint;
        $(`#ai-save-config`).title = hint;
        $(`#ag-save`).title = hint;
        statusEl.textContent = hint;
        agStatusEl.textContent = hint;
    }
}
