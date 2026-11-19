/**
 * AI 配置（独立页面 · 系统运维域）
 *
 * 承载两块能力：
 *   1. 模型配置：协议（OpenAI 兼容 / Anthropic）+ 自填接口地址 + 模型 + API Key + 连接测试
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
    { key: 'allowRemoteExec', title: 'run_host_command / run_batch_command / terminal_run · 远程执行', desc: '在纳管主机（SSH）执行单条或批量命令、在已打开的终端会话中执行命令，同样过黑白名单并审计；开启前建议先白名单演练', danger: true },
    { key: 'allowSqlExecute', title: 'execute_sql / describe_table · 查询数据源', desc: '在已配置数据源上执行只读 SQL 与查看表结构（SELECT / SHOW / DESC / EXPLAIN）', danger: true }
];

export function render() {
    return `
    <div class="card">
        <div class="card-header">
            <div>
                <div class="card-title">模型接入</div>
                <div class="card-desc">可保存多个模型档案并随时切换 · 仅两种协议，地址与模型自填 · API Key 加密存储，保存后仅掩码显示</div>
            </div>
            <span class="badge blue" id="ai-protocol-current" style="display:none"></span>
        </div>
        <div style="max-width:760px">
            <div class="ai-profile-bar">
                <select class="select" id="ai-profile-select" title="选择要编辑 / 启用的模型档案"></select>
                <button class="btn btn-ghost btn-sm" id="ai-profile-new" data-write>＋ 新建</button>
                <button class="btn btn-ghost btn-sm" id="ai-profile-activate" data-write title="设为全局默认：所有未单独切换档案的用户使用该模型">设为默认</button>
                <button class="btn btn-ghost btn-sm" id="ai-profile-delete" data-write>删除</button>
            </div>
            <div class="form-item">
                <label>档案名称（便于识别，留空默认用模型名）</label>
                <input class="input" id="ai-profile-name" placeholder="如：DeepSeek 官方 / 本地 Qwen / Claude">
            </div>
            <div class="ai-protocol-seg" id="ai-protocol-seg" role="tablist">
                <button type="button" class="ai-protocol-opt" data-protocol="openai" role="tab">
                    <strong>OpenAI 兼容</strong>
                    <span>DeepSeek / 通义 / Kimi / Ollama / vLLM 等</span>
                </button>
                <button type="button" class="ai-protocol-opt" data-protocol="anthropic" role="tab">
                    <strong>Anthropic</strong>
                    <span>Claude 官方或兼容网关</span>
                </button>
            </div>
            <div class="ai-protocol-hint" id="ai-protocol-hint"></div>
            <div class="form-item" style="margin-top:14px">
                <label>接口地址（Base URL，不含具体路径）</label>
                <input class="input mono" id="ai-baseurl" placeholder="https://api.deepseek.com">
            </div>
            <div class="form-row">
                <div class="form-item">
                    <label>模型名称</label>
                    <input class="input mono" id="ai-model" placeholder="deepseek-chat">
                </div>
                <div class="form-item">
                    <label>API Key（留空表示不修改）</label>
                    <input class="input" id="ai-key" type="password" placeholder="sk-..." autocomplete="off">
                </div>
            </div>
            <div style="margin-top:10px">
                <button type="button" class="btn-link" id="ai-adv-toggle" style="font-size:12.5px">高级参数（可选）▸</button>
                <div id="ai-adv" style="display:none;margin-top:8px;padding:10px 12px;border:1px solid var(--border);border-radius:8px">
                    <div class="form-item">
                        <label>上下文上限（tokens，留空=不限制；设置后超限会在发送前自动压缩，绝不超限发送）</label>
                        <input class="input" id="ai-ctxlimit" type="number" min="1024" step="1024" placeholder="不限制，如 65536 / 131072">
                    </div>
                    <div class="form-row">
                        <div class="form-item">
                            <label>temperature（0~2，留空=跟随模型默认）</label>
                            <input class="input" id="ai-temp" type="number" min="0" max="2" step="0.1" placeholder="默认">
                        </div>
                        <div class="form-item">
                            <label>top_p（0~1，留空=跟随模型默认）</label>
                            <input class="input" id="ai-topp" type="number" min="0" max="1" step="0.01" placeholder="默认">
                        </div>
                    </div>
                    <div class="form-row">
                        <div class="form-item">
                            <label>思考模式</label>
                            <select class="select" id="ai-thinking">
                                <option value="default">跟随模型默认（不发送参数）</option>
                                <option value="on">开启思考</option>
                                <option value="off">关闭思考</option>
                            </select>
                        </div>
                        <div class="form-item" id="ai-effort-row">
                            <label>思考等级</label>
                            <select class="select" id="ai-effort">
                                <option value="low">低（low）</option>
                                <option value="medium">中（medium）</option>
                                <option value="high">高（high）</option>
                                <option value="max">最高（max）</option>
                            </select>
                        </div>
                    </div>
                    <div class="form-row" id="ai-dialect-row">
                        <div class="form-item">
                            <label>参数方言（思考参数的协议写法，按接入服务手动选择）</label>
                            <select class="select" id="ai-dialect">
                                <option value="standard">标准 OpenAI（reasoning_effort）</option>
                                <option value="deepseek">DeepSeek（thinking 对象 + reasoning_effort）</option>
                                <option value="qwen">Qwen 本地模板（chat_template_kwargs）</option>
                            </select>
                        </div>
                    </div>
                    <div class="form-hint" id="ai-adv-hint"></div>
                </div>
            </div>
            <div class="toolbar" style="margin-top:10px">
                <span class="muted" id="ai-config-status" style="font-size:12px;margin-right:auto"></span>
                <button class="btn btn-ghost" id="ai-test" data-write>测试连接</button>
                <button class="btn btn-primary" id="ai-save-config" data-write>保存档案</button>
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
                <div class="form-item">
                    <label>高危执行模式（远程命令 / 批量执行 / 终端会话执行 / 本机命令）</label>
                    <select class="select" id="ag-execmode">
                        <option value="approve">审批：每次执行前弹窗确认（120 秒未处理自动拒绝）</option>
                        <option value="observe">演练：只记录「本来会执行什么」，不真实下发（黑白名单照常校验）</option>
                        <option value="auto">免审：直接执行（仅建议在受控环境使用）</option>
                    </select>
                </div>
                <div class="form-item" style="margin-top:10px">
                    <label>路由模式（自动发现 → 研判 → 派工，详见「Agent 工作台」）</label>
                    <select class="select" id="ag-routermode">
                        <option value="observe">演练：只做接单研判并记录，不真实派工</option>
                        <option value="active">启用：研判通过后自动派工给 work 节点执行</option>
                    </select>
                </div>
                <div class="form-row" style="margin-bottom:2px">
                    <div class="form-item">
                        <label>研判档案（路由节点）</label>
                        <select class="select" id="ag-routerprofile"></select>
                    </div>
                    <div class="form-item">
                        <label>执行档案（work 节点默认）</label>
                        <select class="select" id="ag-workerprofile"></select>
                    </div>
                </div>
                <div class="form-row" style="margin-bottom:2px">
                    <div class="form-item">
                        <label>并发工作槽</label>
                        <input class="input" id="ag-slots" type="number" min="1" max="4" value="2">
                    </div>
                    <div class="form-item">
                        <label>单工单最大轮次</label>
                        <input class="input" id="ag-tkrounds" type="number" min="1" max="100" value="20">
                    </div>
                    <div class="form-item">
                        <label>单工单时限（分钟）</label>
                        <input class="input" id="ag-tkminutes" type="number" min="1" max="240" value="30">
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
    const protocolSeg = $('#ai-protocol-seg');
    const protocolHint = $('#ai-protocol-hint');
    const currentBadge = $('#ai-protocol-current');

    let agentCfg = null;
    let tools = [];
    let hasKey = false;
    let protocol = 'openai';
    let profiles = [];
    let editingId = null;          // 正在编辑的档案 id；null = 未保存的新档案
    let defaultProfileId = '';     // 全局默认档案 id

    /* ---------------- 协议分段 ---------------- */

    const PROTOCOL_META = {
        openai: { label: 'OpenAI 兼容', endpoint: '{baseURL}/chat/completions', auth: 'Bearer 鉴权', placeholder: 'https://api.deepseek.com', modelEg: 'deepseek-chat' },
        anthropic: { label: 'Anthropic', endpoint: '{baseURL}/v1/messages', auth: 'x-api-key 鉴权', placeholder: 'https://api.anthropic.com', modelEg: 'claude-3-5-sonnet-20241022' }
    };

    function paintProtocol() {
        protocolSeg.querySelectorAll('.ai-protocol-opt').forEach(btn => {
            const on = btn.dataset.protocol === protocol;
            btn.classList.toggle('active', on);
            btn.setAttribute('aria-selected', on ? 'true' : 'false');
        });
        const meta = PROTOCOL_META[protocol] || PROTOCOL_META.openai;
        const dsHint = /deepseek\.com/i.test(String($('#ai-baseurl').value || ''))
            ? '<span>· DeepSeek 模型名：deepseek-chat / deepseek-reasoner / deepseek-flash（2026-11-19 实测均可用，以网关实际为准）</span>' : '';
        protocolHint.innerHTML = `请求端点 <code>${esc(meta.endpoint)}</code><span>· ${esc(meta.auth)}</span>${dsHint}`;
        $('#ai-baseurl').placeholder = meta.placeholder;
        $('#ai-model').placeholder = meta.modelEg;
        paintBadge();
        paintAdv();
    }

    function paintBadge() {
        if (!currentBadge) return;
        const meta = PROTOCOL_META[protocol] || PROTOCOL_META.openai;
        const def = profiles.find(p => p.id === defaultProfileId);
        currentBadge.style.display = '';
        currentBadge.textContent = def
            ? `默认：${def.name} · ${meta.label}`
            : `当前：${meta.label}`;
    }

    function setProtocol(id) {
        protocol = id === 'anthropic' ? 'anthropic' : 'openai';
        paintProtocol();
    }

    /* ---------------- 模型档案 ---------------- */

    function paintProfileBar() {
        const sel = $('#ai-profile-select');
        const opts = profiles.map(p =>
            `<option value="${esc(p.id)}">${esc(p.name)}（${esc(p.model)}）${p.id === defaultProfileId ? ' · 默认' : ''}</option>`).join('');
        sel.innerHTML = (editingId ? '' : '<option value="__new">＋ 新档案（未保存）</option>') + opts;
        sel.value = editingId || '__new';
        const isDefault = editingId && editingId === defaultProfileId;
        $('#ai-profile-activate').disabled = !editingId || isDefault;
        $('#ai-profile-delete').disabled = !editingId || isDefault;
        $('#ai-profile-activate').title = isDefault ? '该档案已是全局默认' : '设为全局默认：所有未单独切换档案的用户使用该模型';
        $('#ai-profile-delete').title = isDefault ? '默认档案不可删除，请先启用其它档案' : '删除该档案';
        paintBadge();
    }

    function fillProfile(p) {
        editingId = p ? p.id : null;
        hasKey = !!(p && p.hasKey);
        protocol = p && p.protocol === 'anthropic' ? 'anthropic' : 'openai';
        $('#ai-profile-name').value = p ? p.name : '';
        $('#ai-baseurl').value = p ? p.baseURL : '';
        $('#ai-model').value = p ? p.model : '';
        $('#ai-key').value = '';
        $('#ai-key').placeholder = hasKey ? '已保存（留空保持不变）' : 'sk-...（本地服务可随意填）';
        fillAdv(p || {});
        paintProtocol();
        paintProfileBar();
    }

    /* ---------------- 高级参数（采样/思考，全部可选） ---------------- */

    function fillAdv(src) {
        $('#ai-ctxlimit').value = src.contextLimit !== undefined && src.contextLimit !== null ? src.contextLimit : '';
        $('#ai-temp').value = src.temperature !== undefined && src.temperature !== null ? src.temperature : '';
        $('#ai-topp').value = src.topP !== undefined && src.topP !== null ? src.topP : '';
        $('#ai-thinking').value = ['default', 'on', 'off'].includes(src.thinking) ? src.thinking : 'default';
        $('#ai-effort').value = ['low', 'medium', 'high', 'max'].includes(src.thinkingEffort) ? src.thinkingEffort : 'high';
        $('#ai-dialect').value = ['standard', 'deepseek', 'qwen'].includes(src.paramDialect) ? src.paramDialect : 'standard';
        paintAdv();
    }

    function paintAdv() {
        const thinking = $('#ai-thinking').value;
        const on = thinking === 'on';
        $('#ai-effort-row').style.display = on ? '' : 'none';
        $('#ai-dialect-row').style.display = protocol === 'openai' ? '' : 'none';
        // D2 护栏：思考开启时采样参数不发送（Anthropic 会 400、DeepSeek 不生效）
        $('#ai-temp').disabled = on;
        $('#ai-topp').disabled = on;
        const hints = [];
        if (on) hints.push('思考模式下 temperature / top_p 不发送（各家服务端不生效或直接拒绝）');
        if (protocol === 'anthropic') hints.push('Anthropic 协议：思考等级映射为 budget_tokens，输出上限自动随之抬高');
        else if ($('#ai-dialect').value === 'deepseek') hints.push('DeepSeek 方言：等级无 medium，中档自动归一为 high');
        else if ($('#ai-dialect').value === 'qwen') hints.push('Qwen 本地模板方言：仅开/关，无等级概念');
        hints.push('本地模型对参数「接受不报错」但生效与否不保证（P0 实测）');
        $('#ai-adv-hint').textContent = hints.join(' · ');
    }

    $('#ai-adv-toggle').addEventListener('click', () => {
        const box = $('#ai-adv');
        const open = box.style.display === 'none';
        box.style.display = open ? '' : 'none';
        $('#ai-adv-toggle').textContent = open ? '高级参数（可选）▾' : '高级参数（可选）▸';
    });
    $('#ai-thinking').addEventListener('change', paintAdv);
    $('#ai-dialect').addEventListener('change', paintAdv);

    function paintConfigStatus() {
        const label = (PROTOCOL_META[protocol] || {}).label || protocol;
        const def = profiles.find(p => p.id === defaultProfileId);
        if (editingId) {
            const p = profiles.find(x => x.id === editingId);
            statusEl.textContent = `编辑档案「${(p && p.name) || ''}」 · ${label} · ${hasKey ? 'Key 已保存' : '未配置 Key'}${def ? ` · 全局默认：${def.name}` : ''}`;
        } else {
            statusEl.textContent = def
                ? `新档案尚未保存 · 全局默认：${def.name}（${def.model}）`
                : '尚无模型档案：填写后点「保存档案」，首个档案自动成为全局默认';
        }
    }

    /* ---------------- Agent 表单 ---------------- */

    function paintAgent() {
        if (!agentCfg) return;
        $('#ag-enabled').checked = !!agentCfg.enabled;
        $('#ag-steps').value = agentCfg.maxSteps;
        $('#ag-timeout').value = agentCfg.commandTimeout;
        $('#ag-rows').value = agentCfg.maxRows;
        $('#ag-execmode').value = ['approve', 'observe', 'auto'].includes(agentCfg.execMode) ? agentCfg.execMode : 'approve';
        $('#ag-routermode').value = agentCfg.routerMode === 'active' ? 'active' : 'observe';
        $('#ag-slots').value = agentCfg.workerSlots ?? 2;
        $('#ag-tkrounds').value = agentCfg.ticketMaxRounds ?? 20;
        $('#ag-tkminutes').value = agentCfg.ticketMaxMinutes ?? 30;
        const profileOpts = sel => {
            const cur = agentCfg[sel === '#ag-routerprofile' ? 'routerProfileId' : 'workerProfileId'] || '';
            $(sel).innerHTML = `<option value="">跟随全局默认档案</option>` +
                profiles.map(p => `<option value="${esc(p.id)}" ${p.id === cur ? 'selected' : ''}>${esc(p.name)}（${esc(p.model)}）</option>`).join('');
        };
        profileOpts('#ag-routerprofile');
        profileOpts('#ag-workerprofile');
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
            maxRows: num('#ag-rows', 200),
            execMode: $('#ag-execmode').value,
            routerMode: $('#ag-routermode').value,
            routerProfileId: $('#ag-routerprofile').value,
            workerProfileId: $('#ag-workerprofile').value,
            workerSlots: num('#ag-slots', 2),
            ticketMaxRounds: num('#ag-tkrounds', 20),
            ticketMaxMinutes: num('#ag-tkminutes', 30)
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
            profiles = cfg.profiles || [];
            defaultProfileId = cfg.profileId || '';
            const current = profiles.find(p => p.id === defaultProfileId) || profiles[0];
            if (current) {
                fillProfile(current);
            } else {
                // 无档案的自定义老配置：回显到新建表单
                fillProfile(null);
                protocol = cfg.protocol === 'anthropic' ? 'anthropic' : 'openai';
                hasKey = !!cfg.hasKey;
                $('#ai-baseurl').value = cfg.baseURL || '';
                $('#ai-model').value = cfg.model || '';
                $('#ai-key').placeholder = hasKey ? '已保存（留空保持不变）' : 'sk-...（本地服务可随意填）';
                fillAdv(cfg);
                paintProtocol();
            }
            paintConfigStatus();
            if (agentCfg) paintAgent();
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

    protocolSeg.addEventListener('click', e => {
        const btn = e.target.closest('.ai-protocol-opt');
        if (btn) setProtocol(btn.dataset.protocol);
    });
    $('#ai-baseurl').addEventListener('input', paintProtocol);

    $('#ai-profile-select').addEventListener('change', e => {
        const id = e.target.value;
        if (id === '__new') { fillProfile(null); paintConfigStatus(); return; }
        const p = profiles.find(x => x.id === id);
        if (p) { fillProfile(p); paintConfigStatus(); }
    });

    $('#ai-profile-new').addEventListener('click', () => {
        if (!guardAdmin('新建模型档案')) return;
        fillProfile(null);
        paintConfigStatus();
        $('#ai-profile-name').focus();
    });

    $('#ai-profile-activate').addEventListener('click', async () => {
        if (!guardAdmin('启用模型档案')) return;
        if (!editingId) return;
        const res = await api.ai.profiles.activate(editingId);
        if (res && res.ok) {
            toast('已设为全局默认模型', 'success');
            await loadConfig();
            window.dispatchEvent(new CustomEvent('sgops:ai-profiles-changed'));
        } else toast((res && res.message) || '启用失败', 'danger');
    });

    $('#ai-profile-delete').addEventListener('click', async () => {
        if (!guardAdmin('删除模型档案')) return;
        if (!editingId) return;
        const p = profiles.find(x => x.id === editingId);
        if (!confirm(`删除模型档案「${(p && p.name) || ''}」？正在使用该档案的用户将回落到全局默认`)) return;
        const res = await api.ai.profiles.remove(editingId);
        if (res && res.ok) {
            toast('档案已删除', 'success');
            await loadConfig();
            window.dispatchEvent(new CustomEvent('sgops:ai-profiles-changed'));
        } else toast((res && res.message) || '删除失败', 'danger');
    });

    $('#ai-test').addEventListener('click', async () => {
        if (!guardAdmin('测试 AI 连接')) return;
        if (!editingId) { toast('请先保存档案，再测试连接', 'warn'); return; }
        const btn = $('#ai-test');
        const old = btn.textContent;
        btn.disabled = true; btn.textContent = '测试中...';
        statusEl.textContent = '正在测试连接...';
        try {
            const res = await api.ai.test($('#ai-model').value.trim(), editingId);
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
        if (!guardAdmin('保存模型档案')) return;
        const btn = $('#ai-save-config');
        btn.disabled = true;
        try {
            const res = await api.ai.profiles.save({
                id: editingId || undefined,
                name: $('#ai-profile-name').value.trim(),
                protocol,
                baseURL: $('#ai-baseurl').value.trim(),
                model: $('#ai-model').value.trim(),
                apiKey: $('#ai-key').value,
                contextLimit: $('#ai-ctxlimit').value,
                temperature: $('#ai-temp').value,
                topP: $('#ai-topp').value,
                thinking: $('#ai-thinking').value,
                thinkingEffort: $('#ai-effort').value,
                paramDialect: $('#ai-dialect').value
            });
            if (res && res.ok) {
                toast('模型档案已保存', 'success');
                profiles = res.profiles || [];
                defaultProfileId = (res.config && res.config.profileId) || '';
                const saved = profiles.find(p => p.id === (res.profile && res.profile.id));
                fillProfile(saved || null);
                paintConfigStatus();
                window.dispatchEvent(new CustomEvent('sgops:ai-profiles-changed'));
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
