/**
 * AI 适配层 · 双协议接入 + Agent 引擎
 * ------------------------------------------------------------------
 * 只保留两种协议，地址 / 模型 / Key 全部由用户自填（不再内置提供方预设）：
 *   openai    OpenAI 兼容：POST {baseURL}/chat/completions · Bearer 鉴权
 *             流式 SSE（data: 行 + [DONE]）· tools[] + tool_calls
 *   anthropic Anthropic：POST {baseURL}/v1/messages · x-api-key + anthropic-version
 *             流式 SSE（content_block_delta/text_delta）· tools[] + tool_use/tool_result
 *
 * 两种协议在引擎内部归一化为同一套 OpenAI 形状的消息与响应
 * （{content, tool_calls}），因此 Agent 循环 / 流式 UI 无需感知协议差异。
 *
 * 配置存储：
 *   db.aiProfiles  = [{ id, name, protocol, baseURL, apiKey(密文), model }]  模型档案（可存多个，管理员维护）
 *   db.aiConfig    = { protocol, baseURL, apiKey(密文), model, profileId }   全局默认配置（profileId 指向启用的档案）
 *   db.aiAgent     = { enabled, maxSteps, ... 能力开关 }          Agent 全局能力配置
 *   db.aiUserPrefs = { [username]: { model, profileId, agentEnabled } }  用户级偏好（档案/模型切换 / 单次开关）
 *   老库的 provider 字段自动按 openai 协议迁移；已有单配置自动迁为首个模型档案，地址/模型/Key 原样保留。
 *   生效顺序：用户偏好档案 > 全局默认档案 > 自定义 aiConfig（此时外置密钥文件优先注入）。
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

/** 协议注册表：仅两种，地址与模型由用户自填 */
const PROTOCOLS = [
    { id: 'openai', label: 'OpenAI 兼容', hint: 'DeepSeek / 通义 / Kimi / 智谱 / Ollama / vLLM 等绝大多数网关' },
    { id: 'anthropic', label: 'Anthropic', hint: 'Claude 官方或兼容 /v1/messages 的网关' }
];

const DEFAULT_CONFIG = {
    protocol: 'openai',
    baseURL: '',
    apiKey: '',
    model: ''
};

/** 协议归一：未知值一律回落 openai（兼容老库 provider 字段） */
const normalizeProtocol = id => (String(id || '').trim() === 'anthropic' ? 'anthropic' : 'openai');
const protocolLabel = id => (normalizeProtocol(id) === 'anthropic' ? 'Anthropic' : 'OpenAI 兼容');

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

/** 非流式总超时（毫秒） */
const TIMEOUT_MS = 60000;
/** 流式空闲超时（毫秒）：每收到数据重置倒计时，持续传输不中断 */
const IDLE_MS = 60000;

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
3. 调用工具前先用一句话说明要做什么；工具失败（ok=false）时换思路重试，最多重试一轮。ok=true 但 exitCode≠0 是命令本身的正常结果（路径不存在/文件有差异/无匹配等），输出与 stderr 就是证据，直接采信继续分析，不要当作故障重试或中断。
4. 涉及删除、覆写、关停等高危动作，先给出方案让用户确认，不要直接执行。
5. 远程执行类工具（run_host_command / run_batch_command / terminal_run）会触发用户审批弹窗，被拒绝时不要反复重试。
6. 远程单条命令必须优先复用用户已打开的终端会话：上下文【当前终端会话】或 list_terminals 给出 sessionId 时用 terminal_run（延续用户当前目录/环境，能看到用户排障现场）；仅当目标主机没有已打开会话时才用 run_host_command（它也会自动优先复用同主机会话）。不要放着现成会话不用而反复新建连接。
7. 若用户圈定了「操作目标」范围，只能对范围内的主机/数据源/会话操作，范围外会被拒绝。
8. 网络类排障先取流量证据：get_proxy_summary 看本地代理流水（哪个进程在报什么错），analyze_pcap 分析用户已打开的流量包（异常连接/HTTP 错误码）；工具提示未打开流量包时，引导用户去「安全运维 → 网络安全 → 流量分析」打开文件后继续。
9. 最终回复要说明「调用了哪些工具 + 得到什么结论」，保持简洁。
10. 终端会话可能被用户手动嵌套 ssh 跳转到其它机器：以工具返回的 currentHost/currentIps 为实际执行主机（list_terminals 与上下文给的是最近探测值）；描述结论时归因到有效主机，不要把跳转后机器上的结果说成建连主机的。run_host_command 发现会话已跳离目标主机时会自动改新建连接。`;

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
 * 模型档案（db.aiProfiles）+ 配置读写
 * ------------------------------------------------------------------ */

const findProfile = id => (store.get('aiProfiles') || []).find(p => p.id === id) || null;

/** 档案 → 引擎配置（Key 解密；档案是用户显式选择，外置密钥不再覆盖） */
function profileConfig(prof) {
    const protocol = normalizeProtocol(prof.protocol);
    const apiKey = decrypt(prof.apiKey);
    return {
        protocol,
        label: protocolLabel(protocol),
        baseURL: String(prof.baseURL || '').replace(/\/+$/, ''),
        model: prof.model || '',
        apiKey,
        configured: !!apiKey,
        fromExternal: false,
        profileId: prof.id,
        profileName: prof.name || prof.model || ''
    };
}

/** 当前生效档案：用户偏好 > 全局默认 */
function resolveProfile(username) {
    const pid = username ? getUserPrefs(username).profileId : '';
    return (pid && findProfile(pid)) || findProfile((store.get('aiConfig') || {}).profileId) || null;
}

function getConfig(username) {
    const prof = resolveProfile(username);
    if (prof) return profileConfig(prof);
    const raw = store.get('aiConfig') || {};
    const ext = secrets.aiOverride();       // 外置密钥文件仅对未启用档案的自定义配置生效
    const protocol = normalizeProtocol(ext.protocol || raw.protocol);
    const apiKey = ext.apiKey || decrypt(raw.apiKey);
    return {
        protocol,
        label: protocolLabel(protocol),
        baseURL: String(ext.baseURL || raw.baseURL || '').replace(/\/+$/, ''),
        model: ext.model || raw.model || '',
        apiKey,
        configured: !!apiKey,
        fromExternal: !!ext.apiKey,
        profileId: '',
        profileName: ''
    };
}

/** 档案清单（脱敏：永不返回 Key 明文/密文） */
function listProfiles() {
    const activeId = (store.get('aiConfig') || {}).profileId || '';
    return (store.get('aiProfiles') || []).map(p => ({
        id: p.id,
        name: p.name || p.model || '未命名档案',
        protocol: normalizeProtocol(p.protocol),
        baseURL: String(p.baseURL || '').replace(/\/+$/, ''),
        model: p.model || '',
        hasKey: !!(p.apiKey && decrypt(p.apiKey)),
        active: p.id === activeId,
        createdAt: p.createdAt || ''
    }));
}

/** 出参脱敏：API Key 永不明文返回；回显全局默认配置 + 档案清单 */
function publicConfig() {
    const cfg = getConfig();
    return {
        protocol: cfg.protocol,
        baseURL: cfg.baseURL,
        model: cfg.model,
        hasKey: cfg.configured,
        externalKey: cfg.fromExternal,
        profileId: cfg.profileId,
        profileName: cfg.profileName,
        profiles: listProfiles(),
        protocols: PROTOCOLS
    };
}

/** 保存档案（新建/编辑）；编辑全局默认档案时同步 aiConfig，无默认时首个档案自动启用 */
function saveProfile(payload = {}) {
    const prev = payload.id ? findProfile(payload.id) : null;
    if (payload.id && !prev) return { ok: false, message: '档案不存在' };
    const protocol = normalizeProtocol(payload.protocol || (prev && prev.protocol));
    const baseURL = String(payload.baseURL || (prev && prev.baseURL) || '').trim().replace(/\/+$/, '');
    if (!/^https?:\/\//.test(baseURL)) return { ok: false, message: '接口地址需以 http(s):// 开头' };
    const model = String(payload.model || (prev && prev.model) || '').trim();
    if (!model) return { ok: false, message: '请填写模型名称' };
    const name = String(payload.name || '').trim() || model;

    let apiKey = (prev && prev.apiKey) || '';
    if (payload.apiKey && payload.apiKey !== mask()) apiKey = encrypt(payload.apiKey);

    const saved = store.upsert('aiProfiles', {
        id: payload.id || undefined,
        name, protocol, baseURL, model, apiKey,
        createdAt: (prev && prev.createdAt) || store.nowText()
    });

    const raw = store.get('aiConfig') || {};
    const isActive = raw.profileId === saved.id;
    const noActive = !findProfile(raw.profileId);
    if (isActive || noActive) {
        store.set('aiConfig', { protocol, baseURL, model, apiKey, profileId: saved.id });
    }
    return { ok: true, profile: listProfiles().find(p => p.id === saved.id), profiles: listProfiles(), config: publicConfig() };
}

function deleteProfile(id) {
    const prof = findProfile(id);
    if (!prof) return { ok: false, message: '档案不存在' };
    if ((store.get('aiConfig') || {}).profileId === id) {
        return { ok: false, message: '当前默认档案不可删除，请先启用其它档案' };
    }
    store.remove('aiProfiles', id);
    // 清理仍指向该档案的用户偏好
    const prefs = store.get('aiUserPrefs') || {};
    Object.keys(prefs).forEach(u => {
        if (prefs[u] && prefs[u].profileId === id) delete prefs[u].profileId;
    });
    store.persist();
    return { ok: true, profiles: listProfiles(), config: publicConfig() };
}

/** 启用档案为全局默认（管理员）：aiConfig 指向该档案 */
function activateProfile(id) {
    const prof = findProfile(id);
    if (!prof) return { ok: false, message: '档案不存在' };
    store.set('aiConfig', {
        protocol: normalizeProtocol(prof.protocol),
        baseURL: String(prof.baseURL || '').replace(/\/+$/, ''),
        model: prof.model || '',
        apiKey: prof.apiKey || '',
        profileId: prof.id
    });
    return { ok: true, config: publicConfig() };
}

/** 用户级档案切换（仅影响本人会话）：同时清掉旧档案下的模型名覆盖 */
function useProfile(username, id) {
    if (id && !findProfile(id)) return { ok: false, message: '档案不存在' };
    saveUserPrefs(username, { profileId: id || '', model: '' });
    return { ok: true };
}

/** 保存自定义配置（不挂档案；apiKey 留空表示不修改；老库 provider 字段被 protocol 取代） */
function saveConfig(payload = {}) {
    const prev = store.get('aiConfig') || {};
    const protocol = normalizeProtocol(payload.protocol || prev.protocol);
    const baseURL = String(payload.baseURL || prev.baseURL || '').trim().replace(/\/+$/, '');
    if (!/^https?:\/\//.test(baseURL)) {
        return { ok: false, message: '接口地址需以 http(s):// 开头' };
    }
    const model = String(payload.model || prev.model || '').trim();
    if (!model) return { ok: false, message: '请填写模型名称' };

    const next = {
        protocol,
        baseURL,
        model,
        apiKey: prev.apiKey || '',
        profileId: ''
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
    if ('profileId' in patch) next.profileId = String(patch.profileId || '').trim();
    if ('agentEnabled' in patch) next.agentEnabled = !!patch.agentEnabled;
    if ('role' in patch) next.role = String(patch.role || '').trim();
    prefs[username] = next;
    store.persist();
    return next;
}

/** 该用户最终生效的模型（用户偏好 > 生效档案/全局配置） */
function resolveModel(username) {
    const cfg = getConfig(username);
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

const parseArgs = raw => {
    if (!raw) return {};
    if (typeof raw === 'object') return raw;
    try { return JSON.parse(raw); } catch (e) { return {}; }
};

/**
 * 拆分前导 system（界面上下文 preamble）与对话主体：
 * 前导 system 永远保留，主体按 keep 截断——避免长会话把上下文挤掉。
 */
function splitPreamble(messages, keep) {
    const arr = Array.isArray(messages) ? messages : [];
    const lead = [];
    let i = 0;
    while (i < arr.length && arr[i] && arr[i].role === 'system') { lead.push(arr[i]); i++; }
    return { lead, rest: arr.slice(i).slice(-keep) };
}

/**
 * 组装最终消息：所有 system 内容（主提示词 + 界面 preamble）合并为唯一一条置顶 system。
 * llama.cpp / Qwen 等本地推理模板只允许开头一条 system，多条或中途出现会直接 500。
 */
function buildMessages(systemText, messages, keep) {
    const { lead, rest } = splitPreamble(messages, keep);
    const sys = [systemText, ...lead.map(m => String((m && m.content) || ''))].filter(Boolean).join('\n\n');
    const body = rest.map(m => (m && m.role === 'system') ? { ...m, role: 'user' } : m);
    return [{ role: 'system', content: sys }, ...body];
}

/** 合并超时信号与用户中止信号（AbortSignal.any 不可用时手动桥接） */
function combineSignals(signals) {
    const list = signals.filter(Boolean);
    if (list.length <= 1) return list[0];
    if (typeof AbortSignal.any === 'function') return AbortSignal.any(list);
    const ctrl = new AbortController();
    for (const s of list) {
        if (s.aborted) { ctrl.abort(s.reason); break; }
        s.addEventListener('abort', () => ctrl.abort(s.reason), { once: true });
    }
    return ctrl.signal;
}

/** 流式空闲看门狗：仅连续 ms 无数据才 abort；touch() 重置倒计时，stop() 结束清理 */
function idleWatchdog(ms) {
    const ctrl = new AbortController();
    let timer = null;
    const arm = () => {
        clearTimeout(timer);
        timer = setTimeout(() => ctrl.abort(new DOMException('The operation was aborted due to timeout', 'TimeoutError')), ms);
    };
    arm();
    return { signal: ctrl.signal, touch: arm, stop: () => clearTimeout(timer) };
}

/* ---------------- 请求体构造（双协议） ---------------- */

function openaiBody(cfg, messages, { stream, model, tools }) {
    const body = { model: model || cfg.model, messages, stream: !!stream };
    if (tools && tools.length) {
        body.tools = tools;
        body.tool_choice = 'auto';
    }
    return body;
}

/** OpenAI 形状消息 → Anthropic messages（system 抽出、tool_calls→tool_use、tool→tool_result） */
function toAnthropicMessages(msgs) {
    const out = [];
    let pending = null;
    const flush = () => {
        if (pending) { out.push({ role: 'user', content: pending }); pending = null; }
    };
    for (const m of msgs) {
        if (m.role === 'tool') {
            pending = pending || [];
            pending.push({
                type: 'tool_result',
                tool_use_id: m.tool_call_id,
                content: typeof m.content === 'string' ? m.content : JSON.stringify(m.content)
            });
            continue;
        }
        flush();
        if (m.role === 'assistant') {
            const calls = Array.isArray(m.tool_calls) ? m.tool_calls : [];
            if (calls.length) {
                const blocks = [];
                if (m.content) blocks.push({ type: 'text', text: String(m.content) });
                calls.forEach(c => blocks.push({
                    type: 'tool_use', id: c.id,
                    name: c.function?.name, input: parseArgs(c.function?.arguments)
                }));
                out.push({ role: 'assistant', content: blocks });
            } else {
                out.push({ role: 'assistant', content: String(m.content || '') });
            }
        } else {
            out.push({ role: 'user', content: typeof m.content === 'string' ? m.content : JSON.stringify(m.content) });
        }
    }
    flush();
    return out;
}

function anthropicBody(cfg, messages, { stream, model, tools }) {
    const sysParts = [];
    const conv = [];
    for (const m of messages) {
        if (m.role === 'system') { if (m.content) sysParts.push(String(m.content)); continue; }
        conv.push(m);
    }
    const body = {
        model: model || cfg.model,
        max_tokens: 4096,
        stream: !!stream,
        messages: toAnthropicMessages(conv)
    };
    if (sysParts.length) body.system = sysParts.join('\n\n');
    if (tools && tools.length) {
        body.tools = tools.map(t => ({
            name: t.function.name,
            description: t.function.description || '',
            input_schema: t.function.parameters || { type: 'object', properties: {} }
        }));
        body.tool_choice = { type: 'auto' };
    }
    return body;
}

/** 响应归一化为 OpenAI 形状 {content, tool_calls}，Agent 循环无需感知协议 */
function normalizeResponse(json, protocol) {
    if (protocol === 'anthropic') {
        const blocks = Array.isArray(json.content) ? json.content : [];
        let text = '';
        const tool_calls = [];
        for (const b of blocks) {
            if (b.type === 'text') text += b.text || '';
            else if (b.type === 'tool_use') {
                tool_calls.push({
                    id: b.id, type: 'function',
                    function: { name: b.name, arguments: JSON.stringify(b.input || {}) }
                });
            }
        }
        return { role: 'assistant', content: text, tool_calls: tool_calls.length ? tool_calls : undefined };
    }
    const msg = json.choices?.[0]?.message || {};
    return { ...msg, role: 'assistant' };
}

/** SSE 单行 data → 增量文本（按协议解析） */
function sseDelta(data, protocol) {
    try {
        const j = JSON.parse(data);
        if (protocol === 'anthropic') {
            return (j.type === 'content_block_delta' && j.delta?.type === 'text_delta') ? (j.delta.text || '') : '';
        }
        return j.choices?.[0]?.delta?.content || '';
    } catch (e) { return ''; }
}

/** 构造 fetch 入参：按协议选择 URL / 鉴权头 / 请求体 */
function requestSpec(cfg, messages, options = {}) {
    const { stream = false, model, tools = null, signal } = options;
    const anthropic = cfg.protocol === 'anthropic';
    const body = anthropic
        ? anthropicBody(cfg, messages, { stream, model, tools })
        : openaiBody(cfg, messages, { stream, model, tools });
    const headers = { 'Content-Type': 'application/json' };
    let url;
    if (anthropic) {
        url = cfg.baseURL.replace(/\/v1$/, '') + '/v1/messages';
        headers['x-api-key'] = cfg.apiKey;
        headers['anthropic-version'] = '2023-06-01';
    } else {
        url = `${cfg.baseURL}/chat/completions`;
        headers['Authorization'] = `Bearer ${cfg.apiKey}`;
    }
    return {
        url,
        init: {
            method: 'POST',
            headers,
            body: JSON.stringify(body),
            signal
        }
    };
}

/** 统一的错误解析：提炼各家返回体中的 message（Anthropic 为 {error:{message}}，OpenAI 同形） */
async function httpError(res) {
    const text = await res.text().catch(() => '');
    let detail = text;
    try { detail = JSON.parse(text).error?.message || text; } catch (e) { /* 保持原文 */ }
    const err = new Error(`AI 接口错误 ${res.status}：${detail}`);
    err.status = res.status;
    return err;
}

/**
 * 带一次自动重试的 fetch：仅对瞬时故障（超时 / 网络抖动 / 5xx / 429）重试，
 * 用户主动中止与 4xx 业务错误不重试。重试前回调 onRetry 供界面/日志提示。
 * 超时策略：opts.idle（流式）用空闲看门狗，持续有数据不中断；否则总超时。
 * 每次尝试独立计时，重试不受上一次已 abort 的信号影响。
 * @returns {Promise<{res: Response, watchdog: object|null}>} 流式调用方负责 touch/stop
 */
async function fetchWithRetry(url, init, opts = {}) {
    const attempt = async () => {
        const wd = opts.idle ? idleWatchdog(IDLE_MS) : null;
        try {
            const signal = combineSignals([wd ? wd.signal : AbortSignal.timeout(TIMEOUT_MS), opts.signal]);
            const res = await fetch(url, { ...init, signal });
            if (!res.ok) {
                const err = await httpError(res);
                err.retryable = res.status >= 500 || res.status === 429;
                throw err;
            }
            return { res, watchdog: wd };
        } catch (err) {
            if (wd) wd.stop();
            throw err;
        }
    };
    try {
        return await attempt();
    } catch (err) {
        if (opts.signal && opts.signal.aborted) throw err;          // 用户中止：不重试
        const transient = err.retryable || err.name === 'TimeoutError' ||
            /timeout|aborted|network|fetch failed|ECONNRESET|ETIMEDOUT|socket|UND_ERR/i.test(err.message || '');
        if (!transient) throw err;
        if (typeof opts.onRetry === 'function') opts.onRetry(err.message);
        await new Promise(r => setTimeout(r, 800));
        if (opts.signal && opts.signal.aborted) throw err;
        return await attempt();
    }
}

/** 入参校验：未配置 Key / 空消息统一前置拦下 */
function assertUsable(cfg, messages) {
    if (!cfg.configured) throw new Error('未配置 AI API Key，请到「AI 配置」填写');
    if (!Array.isArray(messages) || !messages.length) throw new Error('消息内容为空');
}

/**
 * 流式对话：解析 SSE，逐段回调 onDelta（双协议统一）
 * @returns {Promise<string>} 完整回复文本
 */
async function chatStream(messages, options = {}) {
    const { onDelta, model, system, signal, onRetry } = options;
    const cfg = getConfig(options.user);
    assertUsable(cfg, messages);

    const finalMessages = buildMessages(system || SYSTEM_PROMPT, messages, 24);
    const spec = requestSpec(cfg, finalMessages, { stream: true, model, signal });
    const { res, watchdog } = await fetchWithRetry(spec.url, spec.init, { signal, onRetry, idle: true });

    try {
        if (!res.body) throw new Error('AI 接口未返回流式内容');

        const reader = res.body.getReader();
        const decoder = new TextDecoder();
        let buffer = '';
        let full = '';

        while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            watchdog.touch(); // 收到数据即重置空闲倒计时，持续传输不中断
            if (signal && signal.aborted) { reader.cancel().catch(() => {}); break; }
            buffer += decoder.decode(value, { stream: true });

            const lines = buffer.split('\n');
            buffer = lines.pop(); // 末段可能不完整，留到下轮
            for (const line of lines) {
                const s = line.trim();
                if (!s.startsWith('data:')) continue;
                const data = s.slice(5).trim();
                if (!data || data === '[DONE]') continue;
                const delta = sseDelta(data, cfg.protocol);
                if (delta) {
                    full += delta;
                    if (typeof onDelta === 'function') onDelta(delta);
                }
            }
        }
        if (signal && signal.aborted) {
            const err = new Error('已中止生成');
            err.aborted = true;
            throw err;
        }
        return full;
    } catch (err) {
        if (err.name === 'TimeoutError') throw new Error('AI 接口长时间无数据（空闲 60 秒），已中断，请重试或检查模型服务');
        throw err;
    } finally {
        watchdog.stop();
    }
}

/** 非流式完整对话（脚本生成 / 优化等需要一次性结果的场景） */
async function complete(messages, options = {}) {
    const cfg = options.cfg || getConfig(options.user);
    assertUsable(cfg, messages);

    const finalMessages = buildMessages(options.system || SYSTEM_PROMPT, messages, 24);
    const spec = requestSpec(cfg, finalMessages, { stream: false, model: options.model, signal: options.signal });
    const { res } = await fetchWithRetry(spec.url, spec.init, { signal: options.signal, onRetry: options.onRetry });

    const json = await res.json();
    const content = normalizeResponse(json, cfg.protocol).content || '';
    if (!content) throw new Error('AI 未返回有效内容');
    return { text: content, usage: json.usage || null };
}

/* ------------------------------------------------------------------
 * Agent 模式：function calling 循环
 * ------------------------------------------------------------------
 * 工具决策轮走非流式请求（规避各家流式 tool_calls 方言差异），
 * 拿到最终回复后按块回推前端，沿用同一套「边打字边输出」的 UI。
 */

/** 一次带工具的决策请求（响应归一化为 OpenAI 形状） */
async function callWithTools(messages, { cfg, model, tools, signal, onRetry }) {
    const spec = requestSpec(cfg, messages, { stream: false, model, tools, signal });
    const { res } = await fetchWithRetry(spec.url, spec.init, { signal, onRetry });
    const json = await res.json();
    return normalizeResponse(json, cfg.protocol);
}

/** 把最终文本按小块回推，模拟流式效果 */
async function emitText(text, onDelta, signal) {
    if (typeof onDelta !== 'function' || !text) return;
    const size = 18;
    for (let i = 0; i < text.length; i += size) {
        if (signal && signal.aborted) return;
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
    const { onDelta, onStep, user, scope, approve, signal, onRetry } = options;
    const cfg = getConfig(user);
    assertUsable(cfg, messages);

    const agentCfg = options.agent && typeof options.agent === 'object' ? options.agent : {};
    const maxSteps = agentCfg.maxSteps || 6;
    const model = options.model || cfg.model;
    const ctx = { user, agent: { ...agentCfg, enabled: true }, scope: scope || null, approve: approve || null };

    const allowed = agentTools.toolCatalog()
        .filter(t => !t.gate || agentCfg[t.gate])
        .map(t => t.name);
    const tools = allowed.length ? agentTools.toolSchemas(allowed) : null;

    // 本机操作系统：让模型区分 run_local_command（本机语法）与远程 Linux 命令
    const localOs = process.platform === 'win32' ? 'Windows（run_local_command 用 Windows 命令语法，如 dir / type，不要用 ls / cat）'
        : process.platform === 'darwin' ? 'macOS' : 'Linux';
    const envLine = `\n\n【运行环境】平台本机：${localOs}；远程纳管主机通常为 Linux，run_host_command / run_batch_command / terminal_run 用 Linux Shell 语法。`;

    const sysText = `${options.system || SYSTEM_PROMPT}\n\n${AGENT_PROMPT}${describeScope(scope)}${envLine}`;
    const convo = buildMessages(sysText, messages, 16);
    const steps = [];
    let text = '';

    for (let round = 0; round < maxSteps; round++) {
        if (signal && signal.aborted) break;
        const msg = await callWithTools(convo, { cfg, model, tools, signal, onRetry });
        const calls = Array.isArray(msg.tool_calls) ? msg.tool_calls : [];

        if (!calls.length) {
            text = String(msg.content || '').trim();
            break;
        }

        convo.push(msg);
        for (const call of calls) {
            if (signal && signal.aborted) break;
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

    if (signal && signal.aborted) {
        const err = new Error('已中止生成');
        err.aborted = true;
        throw err;
    }

    if (!text) {
        text = steps.length
            ? '已完成工具调用，但模型未给出最终总结。执行结果如下：\n' +
            steps.map(s => `- ${s.label}：${s.ok ? '成功' : '失败 - ' + ((s.result || {}).error || '')}`).join('\n')
            : '未获取到有效回复，请重试或更换模型。';
    }

    await emitText(text, onDelta, signal);
    return { text, steps };
}

/** 连接测试：发送极短消息，返回耗时与结果；profileId 指定时测试该档案（不影响生效配置） */
async function testConnection(model, profileId) {
    const started = Date.now();
    let cfg;
    if (profileId) {
        const prof = findProfile(profileId);
        if (!prof) return { ok: false, durationMs: 0, message: '档案不存在，请先保存' };
        cfg = profileConfig(prof);
    } else {
        cfg = getConfig();
    }
    if (!cfg.configured) return { ok: false, durationMs: Date.now() - started, message: '尚未配置 API Key' };
    const target = model || cfg.model;
    try {
        const { text } = await complete([{ role: 'user', content: '请回复"OK"' }], { model: target, cfg });
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
    PROTOCOLS, DEFAULT_CONFIG, AGENT_DEFAULTS, SYSTEM_PROMPT,
    normalizeProtocol, protocolLabel, getConfig, publicConfig, saveConfig,
    listProfiles, saveProfile, deleteProfile, activateProfile, useProfile,
    getAgentConfig, saveAgentConfig,
    listRoles, saveRole, deleteRole, resolveSystem,
    getUserPrefs, saveUserPrefs, resolveModel, agentState,
    chatStream, complete, chatAgent, testConnection
};
