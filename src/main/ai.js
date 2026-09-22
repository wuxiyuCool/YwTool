/**
 * AI 适配层 · 多模型注册表 + Agent 引擎
 * ------------------------------------------------------------------
 * 统一契约（OpenAI 兼容 chat/completions）：
 *   默认地址  {baseURL}/chat/completions
 *   鉴权      Authorization: Bearer <apiKey>
 *   流式      stream: true → SSE（data: 行 + [DONE]）
 *   工具调用  tools[] + tool_calls（function calling，用于 Agent 模式）
 *
 * 扩展方式：在 PROVIDERS 中追加一条 { id, label, baseURL, model, models }，
 *   配置界面与模型下拉会自动出现该提供方的预设模型；baseURL / model 均可被用户覆写。
 *
 * 配置存储：
 *   db.aiConfig    = { provider, baseURL, apiKey(密文), model }  全局模型配置（管理员维护）
 *   db.aiAgent     = { enabled, maxSteps, ... 能力开关 }          Agent 全局能力配置
 *   db.aiUserPrefs = { [username]: { model, agentEnabled } }     用户级偏好（模型切换 / 单次开关）
 *
 * 安全边界：
 *   - 模型与 Agent 全局门槛由管理员在「AI 配置」页设定
 *   - 用户可在 AI 面板切换模型，仅影响本人会话
 *   - Agent 实际可用工具以 db.aiAgent 能力开关为准，工具层会二次校验
 */
const store = require('./store');
const { encrypt, decrypt, mask } = require('./crypto');
const secrets = require('./secrets');
const agentTools = require('./agentTools');

/** 模型提供方注册表（每个提供方带预设模型，供下拉与配置页直接选用） */
const PROVIDERS = [
    {
        id: 'deepseek', label: 'DeepSeek 深度求索', baseURL: 'https://api.deepseek.com',
        model: 'deepseek-chat', models: ['deepseek-chat', 'deepseek-reasoner']
    },
    {
        id: 'qwen', label: '通义千问（阿里云百炼）', baseURL: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
        model: 'qwen-plus', models: ['qwen-turbo', 'qwen-plus', 'qwen-max', 'qwen-long', 'qwen-coder-plus']
    },
    {
        id: 'kimi', label: 'Kimi（Moonshot）', baseURL: 'https://api.moonshot.cn/v1',
        model: 'moonshot-v1-8k', models: ['moonshot-v1-8k', 'moonshot-v1-32k', 'moonshot-v1-128k']
    },
    {
        id: 'zhipu', label: '智谱 GLM', baseURL: 'https://open.bigmodel.cn/api/paas/v4',
        model: 'glm-4-flash', models: ['glm-4-flash', 'glm-4-air', 'glm-4-plus', 'glm-4-long']
    },
    {
        id: 'doubao', label: '豆包（火山方舟）', baseURL: 'https://ark.cn-beijing.volces.com/api/v3',
        model: 'doubao-pro-32k', models: ['doubao-pro-32k', 'doubao-lite-32k', 'doubao-pro-128k']
    },
    {
        id: 'siliconflow', label: '硅基流动 SiliconFlow', baseURL: 'https://api.siliconflow.cn/v1',
        model: 'Qwen/Qwen2.5-7B-Instruct',
        models: ['Qwen/Qwen2.5-7B-Instruct', 'Qwen/Qwen2.5-Coder-7B-Instruct', 'deepseek-ai/DeepSeek-V3', 'THUDM/glm-4-9b-chat']
    },
    {
        id: 'openai', label: 'OpenAI', baseURL: 'https://api.openai.com/v1',
        model: 'gpt-4o-mini', models: ['gpt-4o', 'gpt-4o-mini', 'gpt-4.1-mini', 'o3-mini']
    },
    {
        id: 'ollama', label: 'Ollama（本地私有化）', baseURL: 'http://localhost:11434/v1',
        model: 'llama3.1', models: ['llama3.1', 'qwen2.5', 'deepseek-r1:7b']
    },
    { id: 'custom', label: '自定义（OpenAI 兼容）', baseURL: '', model: '', models: [] }
];

const DEFAULT_CONFIG = {
    provider: 'deepseek',
    baseURL: 'https://api.deepseek.com',
    apiKey: '',
    model: 'deepseek-chat'
};

/** Agent 默认配置：能力默认收紧，由管理员显式放开 */
const AGENT_DEFAULTS = {
    enabled: false,          // 总开关：关闭时 AI 面板不提供 Agent 开关，也不走工具链路
    maxSteps: 6,             // 单次会话最大工具轮次，防止死循环
    allowDataGenerate: true, // generate_data
    allowSaveScript: true,   // save_script
    allowLocalExec: false,   // run_local_command（高危，默认关）
    allowRemoteExec: false,  // run_host_command（SSH 远程执行，高危，默认关）
    allowSqlExecute: false,  // execute_sql / describe_table（数据源侧，默认关）
    execApproval: true,      // 高危执行前弹窗审批：默认开启，用户逐次同意才执行
    commandTimeout: 15,      // 本机命令超时（秒）
    maxRows: 200             // 单工具数据行数上限
};

/** 默认对话超时（毫秒） */
const TIMEOUT_MS = 60000;

/** 系统提示词：定位为运维助手，约束输出格式 */
const SYSTEM_PROMPT = `你是 SgOps 批量运维管理平台的 AI 运维助手，服务于内网运维场景。
能力与约束：
1. 回答 Linux 服务器运维、Shell/Python 脚本、数据库（Oracle/MySQL）运维问题。
2. 生成脚本时只输出脚本本体，必要时在脚本后用「说明：」简要列出要点，不要输出冗长解释。
3. 涉及危险命令（删除、格式化、防火墙清空等）必须主动提示风险与安全建议。
4. 回答保持简洁、可执行、面向运维。`;

/** Agent 模式追加的系统约束 */
const AGENT_PROMPT = `你现在具备工具调用（Agent）能力，按以下规则完成任务：
1. 需要真实数据（主机清单、数据源清单、表内容）时必须调用工具，不要凭猜测编造数据。
2. 生成测试数据用 generate_data；产出可复用脚本用 save_script 落库，不要只在回复里贴代码。
3. 调用工具前先用一句话说明要做什么；工具失败时换思路重试，最多重试一轮。
4. 涉及删除、覆写、关停等高危动作，先给出方案让用户确认，不要直接执行。
5. 远程执行类工具（run_host_command / run_batch_command / terminal_run）会触发用户审批弹窗，被拒绝时不要反复重试。
6. 排障优先复用用户已打开的终端会话：list_terminals 查看，terminal_run 在该 shell 执行（延续其目录/环境）；无合适会话再用 run_host_command 新建连接。
7. 若用户圈定了「操作目标」范围，只能对范围内的主机/数据源/会话操作，范围外会被拒绝。
8. 最终回复要说明「调用了哪些工具 + 得到什么结论」，保持简洁。`;

const providerById = id => PROVIDERS.find(p => p.id === id) || null;

/** 把用户圈定的操作目标 id 解析成名称，追加到 Agent 系统提示，让模型知道可用范围 */
function describeScope(scope) {
    if (!scope || typeof scope !== 'object') return '';
    const hosts = (scope.hostIds || []).map(id => {
        const h = store.find('hosts', id); return h ? `${h.name}(${h.ip},id=${id})` : `id=${id}`;
    });
    const dbs = (scope.dbIds || []).map(id => {
        const s = store.find('dbSources', id); return s ? `${s.name}[${s.type}],id=${id}` : `id=${id}`;
    });
    const terms = (scope.sessionIds || []).map(id => {
        const t = (require('./handlers/terminalHandler').listSessions().find(s => s.sessionId === id));
        return t ? `${t.hostName},sessionId=${id}` : `sessionId=${id}`;
    });
    const lines = [];
    if (hosts.length) lines.push(`主机：${hosts.join('、')}`);
    if (dbs.length) lines.push(`数据源：${dbs.join('、')}`);
    if (terms.length) lines.push(`终端会话：${terms.join('、')}`);
    if (!lines.length) return '';
    return `\n\n【本次操作范围（用户圈定，范围外目标会被拒绝）】\n${lines.join('\n')}`;
}

/* ------------------------------------------------------------------
 * 提示词角色（db.aiRoles）
 * builtin 预设：可在配置页改文案，不可删除；用户自定义角色可增删。
 * 对话时的 system 取用顺序：本次指定 role > 用户偏好 prefs.role > 内置默认 SYSTEM_PROMPT
 * ------------------------------------------------------------------ */

function listRoles() {
    return store.list('aiRoles').map(r => ({
        id: r.id, name: r.name, desc: r.desc || '',
        prompt: r.prompt || '', builtin: !!r.builtin
    }));
}

function saveRole(payload = {}) {
    const name = String(payload.name || '').trim();
    const prompt = String(payload.prompt || '').trim();
    if (!name) return { ok: false, message: '角色名称不能为空' };
    if (!prompt) return { ok: false, message: '提示词内容不能为空' };
    if (prompt.length > 8000) return { ok: false, message: '提示词超过 8000 字符上限' };
    const prev = store.list('aiRoles').find(r => r.id === payload.id);
    if (payload.id && !prev) return { ok: false, message: '角色不存在' };
    const saved = store.upsert('aiRoles', {
        id: payload.id || undefined,
        name,
        desc: String(payload.desc || '').trim(),
        prompt,
        builtin: prev ? prev.builtin : false
    });
    return { ok: true, role: { id: saved.id, name: saved.name, desc: saved.desc, builtin: !!saved.builtin } };
}

function deleteRole(id) {
    const role = store.find('aiRoles', id);
    if (!role) return { ok: false, message: '角色不存在' };
    if (role.builtin) return { ok: false, message: `内置角色「${role.name}」不可删除，可编辑覆盖其提示词` };
    const ok = store.remove('aiRoles', id);
    // 清理仍指向该角色的用户偏好
    const prefs = store.get('aiUserPrefs') || {};
    Object.keys(prefs).forEach(u => {
        if (prefs[u] && prefs[u].role === id) { delete prefs[u].role; }
    });
    store.persist();
    return { ok };
}

/** 解析本次对话生效的 system 提示词 */
function resolveSystem(roleId, username) {
    const id = String(roleId || '').trim() || (username ? getUserPrefs(username).role : '');
    if (!id) return SYSTEM_PROMPT;
    const role = store.list('aiRoles').find(r => r.id === id);
    return (role && role.prompt) || SYSTEM_PROMPT;
}

/* ------------------------------------------------------------------
 * 配置读写
 * ------------------------------------------------------------------ */

function getConfig() {
    const raw = store.get('aiConfig') || {};
    const ext = secrets.aiOverride();       // 外置密钥文件优先注入（ai.apiKey 等）
    const provider = providerById(ext.provider || raw.provider) || PROVIDERS[0];
    const apiKey = ext.apiKey || decrypt(raw.apiKey);
    return {
        provider: provider.id,
        label: provider.label,
        baseURL: (ext.baseURL || raw.baseURL || provider.baseURL).replace(/\/+$/, ''),
        model: ext.model || raw.model || provider.model,
        apiKey,
        configured: !!apiKey,
        fromExternal: !!ext.apiKey
    };
}

/** 出参脱敏：API Key 永不明文返回 */
function publicConfig() {
    const raw = store.get('aiConfig') || {};
    const ext = secrets.aiOverride();
    return {
        provider: raw.provider || 'deepseek',
        baseURL: raw.baseURL || '',
        model: raw.model || '',
        hasKey: !!(ext.apiKey || (raw.apiKey && decrypt(raw.apiKey))),
        externalKey: !!ext.apiKey,
        providers: PROVIDERS
    };
}

/** 保存配置（apiKey 留空表示不修改） */
function saveConfig(payload = {}) {
    const prev = store.get('aiConfig') || {};
    const providerId = providerById(payload.provider) ? payload.provider : (prev.provider || 'deepseek');
    const provider = providerById(providerId) || PROVIDERS[0];
    const baseURL = String(payload.baseURL || prev.baseURL || provider.baseURL).trim().replace(/\/+$/, '');
    if (!/^https?:\/\//.test(baseURL)) {
        return { ok: false, message: '接口地址需以 http(s):// 开头' };
    }
    const model = String(payload.model || prev.model || provider.model).trim();
    if (!model) return { ok: false, message: '请填写模型名称' };

    const next = {
        provider: providerId,
        baseURL,
        model,
        apiKey: prev.apiKey || ''
    };
    // 传入新 Key（非掩码占位）才更新密文
    if (payload.apiKey && payload.apiKey !== mask()) {
        next.apiKey = encrypt(payload.apiKey);
        secrets.syncSetAi(payload.apiKey);
    }
    store.set('aiConfig', next);
    return { ok: true, config: publicConfig() };
}

/** Agent 全局配置读取（缺失字段由默认值兜底，兼容老库） */
function getAgentConfig() {
    const raw = store.get('aiAgent');
    return { ...AGENT_DEFAULTS, ...(raw && typeof raw === 'object' ? raw : {}) };
}

/** Agent 全局配置保存（仅接受已知键，布尔/数值做类型收敛） */
function saveAgentConfig(payload = {}) {
    const prev = getAgentConfig();
    const boolKeys = ['enabled', 'allowDataGenerate', 'allowSaveScript', 'allowLocalExec', 'allowRemoteExec', 'allowSqlExecute', 'execApproval'];
    const limits = {
        maxSteps: [1, 12],
        commandTimeout: [1, 120],
        maxRows: [10, 2000]
    };
    const next = { ...prev };

    boolKeys.forEach(k => { if (k in payload) next[k] = !!payload[k]; });
    Object.keys(limits).forEach(k => {
        if (!(k in payload)) return;
        const v = Number(payload[k]);
        if (!Number.isFinite(v)) return;
        const [min, max] = limits[k];
        next[k] = Math.min(Math.max(Math.round(v), min), max);
    });

    store.set('aiAgent', next);
    return { ok: true, agent: next };
}

/* ------------------------------------------------------------------
 * 用户级偏好（模型切换 / Agent 开关）
 * ------------------------------------------------------------------ */

function prefsRoot() {
    const db = store.load();
    if (!db.aiUserPrefs || typeof db.aiUserPrefs !== 'object') {
        db.aiUserPrefs = {};
        store.persist();
    }
    return db.aiUserPrefs;
}

/** 某用户的偏好：{ model, agentEnabled } */
function getUserPrefs(username) {
    if (!username) return {};
    const prefs = prefsRoot()[username];
    return prefs && typeof prefs === 'object' ? { ...prefs } : {};
}

function saveUserPrefs(username, patch = {}) {
    if (!username) return {};
    const prefs = prefsRoot();
    const next = { ...(prefs[username] || {}) };
    if ('model' in patch) next.model = String(patch.model || '').trim();
    if ('agentEnabled' in patch) next.agentEnabled = !!patch.agentEnabled;
    if ('role' in patch) next.role = String(patch.role || '').trim();
    prefs[username] = next;
    store.persist();
    return next;
}

/** 该用户最终生效的模型（用户偏好 > 全局配置） */
function resolveModel(username) {
    const cfg = getConfig();
    return getUserPrefs(username).model || cfg.model;
}

/** 当前用户的 Agent 状态：全局配置 + 个人开关 + 可用工具 */
function agentState(username) {
    const cfg = getAgentConfig();
    const prefs = getUserPrefs(username);
    return {
        global: cfg,
        enabled: !!cfg.enabled && prefs.agentEnabled !== false,
        userPref: prefs.agentEnabled,
        tools: agentTools.toolCatalog().filter(t => !t.gate || cfg[t.gate])
    };
}

/* ------------------------------------------------------------------
 * HTTP 请求构造
 * ------------------------------------------------------------------ */

function buildRequest(cfg, messages, options = {}) {
    const { stream = false, model, tools = null } = options;
    const body = { model: model || cfg.model, messages, stream };
    if (tools && tools.length) {
        body.tools = tools;
        body.tool_choice = 'auto';
    }
    return {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${cfg.apiKey}`
        },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(TIMEOUT_MS)
    };
}

/** 统一的错误解析：提炼各家返回体中的 message */
async function httpError(res) {
    const text = await res.text().catch(() => '');
    let detail = text;
    try { detail = JSON.parse(text).error?.message || text; } catch (e) { /* 保持原文 */ }
    return new Error(`AI 接口错误 ${res.status}：${detail}`);
}

/** 入参校验：未配置 Key / 空消息统一前置拦下 */
function assertUsable(cfg, messages) {
    if (!cfg.configured) throw new Error('未配置 AI API Key，请到「AI 配置」填写');
    if (!Array.isArray(messages) || !messages.length) throw new Error('消息内容为空');
}

/**
 * 流式对话：解析 SSE，逐段回调 onDelta
 * @returns {Promise<string>} 完整回复文本
 */
async function chatStream(messages, options = {}) {
    const { onDelta, model, system } = options;
    const cfg = getConfig();
    assertUsable(cfg, messages);

    const finalMessages = [{ role: 'system', content: system || SYSTEM_PROMPT }].concat(messages.slice(-24));
    const res = await fetch(`${cfg.baseURL}/chat/completions`, buildRequest(cfg, finalMessages, { stream: true, model }));

    if (!res.ok) throw await httpError(res);
    if (!res.body) throw new Error('AI 接口未返回流式内容');

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    let full = '';

    while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });

        const lines = buffer.split('\n');
        buffer = lines.pop(); // 末段可能不完整，留到下轮
        for (const line of lines) {
            const s = line.trim();
            if (!s.startsWith('data:')) continue;
            const data = s.slice(5).trim();
            if (!data || data === '[DONE]') continue;
            let delta = '';
            try {
                delta = JSON.parse(data).choices?.[0]?.delta?.content || '';
            } catch (e) { /* 忽略残缺行 */ }
            if (delta) {
                full += delta;
                if (typeof onDelta === 'function') onDelta(delta);
            }
        }
    }
    return full;
}

/** 非流式完整对话（脚本生成 / 优化等需要一次性结果的场景） */
async function complete(messages, options = {}) {
    const cfg = getConfig();
    assertUsable(cfg, messages);

    const finalMessages = [{ role: 'system', content: options.system || SYSTEM_PROMPT }].concat(messages.slice(-24));
    const res = await fetch(`${cfg.baseURL}/chat/completions`, buildRequest(cfg, finalMessages, { stream: false, model: options.model }));

    if (!res.ok) throw await httpError(res);
    const json = await res.json();
    const content = json.choices?.[0]?.message?.content || '';
    if (!content) throw new Error('AI 未返回有效内容');
    return { text: content, usage: json.usage || null };
}

/* ------------------------------------------------------------------
 * Agent 模式：function calling 循环
 * ------------------------------------------------------------------
 * 工具决策轮走非流式请求（规避各家流式 tool_calls 方言差异），
 * 拿到最终回复后按块回推前端，沿用同一套「边打字边输出」的 UI。
 */

const parseArgs = raw => {
    if (!raw) return {};
    try { return JSON.parse(raw); } catch (e) { return {}; }
};

/** 一次带工具的决策请求 */
async function callWithTools(messages, { cfg, model, tools }) {
    const res = await fetch(`${cfg.baseURL}/chat/completions`, buildRequest(cfg, messages, { stream: false, model, tools }));
    if (!res.ok) throw await httpError(res);
    const json = await res.json();
    return json.choices?.[0]?.message || {};
}

/** 把最终文本按小块回推，模拟流式效果 */
async function emitText(text, onDelta) {
    if (typeof onDelta !== 'function' || !text) return;
    const size = 18;
    for (let i = 0; i < text.length; i += size) {
        onDelta(text.slice(i, i + size));
        await new Promise(r => setTimeout(r, 12));
    }
}

/**
 * Agent 对话：模型决策 → 工具执行 → 结果回填 → 最终成文
 * @param {Array} messages 会话消息（不含 system）
 * @param {{onDelta?, onStep?, model?, user?, agent?}} options
 * @returns {Promise<{text:string, steps:Array}>}
 */
async function chatAgent(messages, options = {}) {
    const { onDelta, onStep, user, scope, approve } = options;
    const cfg = getConfig();
    assertUsable(cfg, messages);

    const agentCfg = options.agent && typeof options.agent === 'object' ? options.agent : {};
    const maxSteps = agentCfg.maxSteps || 6;
    const model = options.model || cfg.model;
    const ctx = { user, agent: { ...agentCfg, enabled: true }, scope: scope || null, approve: approve || null };

    const allowed = agentTools.toolCatalog()
        .filter(t => !t.gate || agentCfg[t.gate])
        .map(t => t.name);
    const tools = allowed.length ? agentTools.toolSchemas(allowed) : null;

    const convo = [{ role: 'system', content: `${options.system || SYSTEM_PROMPT}\n\n${AGENT_PROMPT}${describeScope(scope)}` }].concat(messages.slice(-16));
    const steps = [];
    let text = '';

    for (let round = 0; round < maxSteps; round++) {
        const msg = await callWithTools(convo, { cfg, model, tools });
        const calls = Array.isArray(msg.tool_calls) ? msg.tool_calls : [];

        if (!calls.length) {
            text = String(msg.content || '').trim();
            break;
        }

        convo.push(msg);
        for (const call of calls) {
            const name = call.function?.name;
            const args = parseArgs(call.function?.arguments);
            const label = (agentTools.TOOLS[name] || {}).label || name;
            const summary = Object.entries(args || {})
                .map(([k, v]) => `${k}=${typeof v === 'string' && v.length > 40 ? v.slice(0, 40) + '…' : JSON.stringify(v)}`)
                .join(', ');
            if (typeof onStep === 'function') onStep({ type: 'call', round: round + 1, name, label, summary });

            const result = await agentTools.runTool(name, args, ctx);
            const step = { round: round + 1, name, label, ok: !!result.ok, result };
            steps.push(step);
            if (typeof onStep === 'function') onStep({ type: 'result', ...step });

            convo.push({
                role: 'tool',
                tool_call_id: call.id,
                name,
                content: JSON.stringify(result).slice(0, 4000)
            });
        }
        text = '';
    }

    if (!text) {
        text = steps.length
            ? '已完成工具调用，但模型未给出最终总结。执行结果如下：\n' +
            steps.map(s => `- ${s.label}：${s.ok ? '成功' : '失败 - ' + ((s.result || {}).error || '')}`).join('\n')
            : '未获取到有效回复，请重试或更换模型。';
    }

    await emitText(text, onDelta);
    return { text, steps };
}

/** 连接测试：发送极短消息，返回耗时与结果 */
async function testConnection(model) {
    const started = Date.now();
    const cfg = getConfig();
    if (!cfg.configured) return { ok: false, durationMs: Date.now() - started, message: '尚未配置 API Key' };
    const target = model || resolveModel();
    try {
        const { text } = await complete([{ role: 'user', content: '请回复"OK"' }], { model: target });
        return {
            ok: true,
            durationMs: Date.now() - started,
            message: `连接成功 · ${cfg.label} · ${target}（${Math.round(text.length > 20 ? 20 : text.length)} 字符）`
        };
    } catch (err) {
        return { ok: false, durationMs: Date.now() - started, message: `连接失败：${err.message}` };
    }
}

module.exports = {
    PROVIDERS, DEFAULT_CONFIG, AGENT_DEFAULTS, SYSTEM_PROMPT,
    providerById, getConfig, publicConfig, saveConfig,
    getAgentConfig, saveAgentConfig,
    listRoles, saveRole, deleteRole, resolveSystem,
    getUserPrefs, saveUserPrefs, resolveModel, agentState,
    chatStream, complete, chatAgent, testConnection
};
