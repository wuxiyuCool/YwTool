/**
 * AI 助手 IPC
 * 通道：ai:config:get|save / ai:test / ai:chat / ai:chat:history|clear
 *       ai:sessions:list|new|switch|delete / ai:script:generate|optimize
 *       ai:model:get|save / ai:agent:get|save|toggle|tools
 *       ai:roles:list / ai:roles:save|delete（管理员）/ ai:role:save（用户选择默认角色）
 *
 * 安全约束：
 *   - ai:config:save / ai:test / ai:roles:save / ai:roles:delete 为管理员专属（auth.ADMIN_ONLY）
 *   - ai:chat / ai:script:* 为写操作，需 operator 及以上
 *   - 会话按用户隔离（db.aiSessions[username]，多会话 + 激活指针 db.aiActive）
 *   - 提示词角色只影响 system 提示，不改变任何权限边界
 *   - 每次 AI 调用写入审计日志（含耗时，不含明文内容）
 */
const store = require('../store');
const audit = require('../auditLogger');
const auth = require('../auth');
const ai = require('../ai');
const agentTools = require('../agentTools');

const HISTORY_LIMIT = 40;

const operator = () => (auth.getSession() || {}).username || '-';

function log(detail, result = 'success') {
    audit.write({ type: '操作', user: operator(), detail, result });
}

/** 读取当前用户的会话列表（旧版单会话 db.aiChats 首次访问时自动迁移） */
function sessionsOf(username) {
    const db = store.load();
    if (!db.aiSessions || typeof db.aiSessions !== 'object') db.aiSessions = {};
    let list = db.aiSessions[username];
    if (!Array.isArray(list)) list = [];

    const legacy = db.aiChats && Array.isArray(db.aiChats[username]) ? db.aiChats[username] : [];
    if (!list.length && legacy.length) {
        const msgs = legacy.filter(m => m && m.role && m.content);
        list.push({
            id: 's_' + Date.now().toString(36),
            title: ((msgs.find(m => m.role === 'user') || {}).content || '历史会话').slice(0, 24),
            messages: msgs,
            createdAt: (msgs[0] || {}).at || store.nowText(),
            updatedAt: (msgs[msgs.length - 1] || {}).at || store.nowText()
        });
        delete db.aiChats[username];
        db.aiSessions[username] = list;
        store.persist();
    }
    return list;
}

/** 当前激活会话 id（失效时回落到第一个会话） */
function activeIdOf(username, sessions) {
    const db = store.load();
    if (!db.aiActive || typeof db.aiActive !== 'object') db.aiActive = {};
    const list = Array.isArray(sessions) ? sessions : sessionsOf(username);
    let id = db.aiActive[username];
    if (!list.some(s => s.id === id)) {
        id = list.length ? list[0].id : null;
        db.aiActive[username] = id;
    }
    return id;
}

/** 取当前激活会话（无则返回 null） */
function activeSession(username) {
    const list = sessionsOf(username);
    const id = activeIdOf(username, list);
    return list.find(s => s.id === id) || null;
}

/** 会话元数据（不含消息体） */
const sessionMeta = s => ({
    id: s.id,
    title: s.title,
    messageCount: (s.messages || []).length,
    updatedAt: s.updatedAt
});

/** 追加消息到当前激活会话（无会话则自动创建）并裁剪至上限 */
function pushHistory(username, messages) {
    const db = store.load();
    if (!db.aiSessions || typeof db.aiSessions !== 'object') db.aiSessions = {};
    const list = sessionsOf(username);
    let session = activeSession(username);
    if (!session) {
        session = {
            id: 's_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
            title: '', messages: [],
            createdAt: store.nowText(), updatedAt: store.nowText()
        };
        list.push(session);
    }
    const firstUser = messages.find(m => m.role === 'user');
    if (!session.title && firstUser) session.title = String(firstUser.content || '新会话').slice(0, 24);
    session.messages.push(...messages);
    session.messages = session.messages.slice(-HISTORY_LIMIT);
    session.updatedAt = store.nowText();
    db.aiSessions[username] = list;
    db.aiActive[username] = session.id;
    store.persist();
    return session;
}

function setup(ipcMain) {
    /* ---------------- 配置 ---------------- */

    ipcMain.handle('ai:config:get', () => ({
        ok: true,
        config: ai.publicConfig()
    }));

    ipcMain.handle('ai:config:save', (e, payload = {}) => {
        const result = ai.saveConfig(payload);
        if (result.ok) {
            const cfg = ai.publicConfig();
            log(`更新 AI 模型配置（${cfg.provider} · ${cfg.model}）`);
        }
        return result;
    });

    ipcMain.handle('ai:test', async (e, { model } = {}) => {
        const result = await ai.testConnection(model);
        log(`AI 连接测试：${result.message}`, result.ok ? 'success' : 'failed');
        return result;
    });

    /* ---------------- 模型切换（用户级偏好） ---------------- */

    ipcMain.handle('ai:model:get', () => {
        const cfg = ai.getConfig();
        const prefs = ai.getUserPrefs(operator());
        return {
            ok: true,
            provider: cfg.provider,
            configured: cfg.configured,
            defaultModel: cfg.model,
            model: ai.resolveModel(operator()),
            providers: ai.PROVIDERS,
            prefs
        };
    });

    /** 切换当前用户本次会话使用的模型（写操作，需 operator 及以上） */
    ipcMain.handle('ai:model:save', (e, { model } = {}) => {
        const name = String(model || '').trim();
        if (!name) return { ok: false, message: '模型名不能为空' };
        const prefs = ai.saveUserPrefs(operator(), { model: name });
        log(`切换 AI 模型：${name}`);
        return { ok: true, model: prefs.model };
    });

    /* ---------------- Agent 能力（全局配置管理员维护，个人开关用户自助） ---------------- */

    ipcMain.handle('ai:agent:get', () => ({ ok: true, ...ai.agentState(operator()) }));

    ipcMain.handle('ai:agent:tools', () => ({
        ok: true,
        catalog: ai.getAgentConfig(),
        tools: agentTools.toolCatalog(),
        defaults: ai.AGENT_DEFAULTS
    }));

    ipcMain.handle('ai:agent:save', (e, payload = {}) => {
        const result = ai.saveAgentConfig(payload);
        if (!result.ok) return result;
        const agent = result.agent;
        log(`更新 Agent 配置（总开关 ${agent.enabled ? '开' : '关'} · 本机命令 ${agent.allowLocalExec ? '开' : '关'} · SQL 查询 ${agent.allowSqlExecute ? '开' : '关'}）`);
        return { ok: true, agent };
    });

    /** 用户自助开关：全局管理员关闭时不允许个人打开 */
    ipcMain.handle('ai:agent:toggle', (e, { enabled } = {}) => {
        const cfg = ai.getAgentConfig();
        if (!cfg.enabled) return { ok: false, message: 'Agent 总开关未开启，请联系系统管理员在「AI 配置」中启用' };
        const prefs = ai.saveUserPrefs(operator(), { agentEnabled: !!enabled });
        log(`${enabled ? '开启' : '关闭'} AI Agent 助手`);
        return { ok: true, enabled: !!prefs.agentEnabled };
    });

    /* ---------------- 提示词角色 ---------------- */

    /** 角色清单（全员可读，供面板下拉；prompt 只在配置页编辑时需要，一并返回） */
    ipcMain.handle('ai:roles:list', () => ({
        ok: true,
        roles: ai.listRoles(),
        current: ai.getUserPrefs(operator()).role || ''
    }));

    /** 新增 / 修改角色（内置角色可改文案不可删） */
    ipcMain.handle('ai:roles:save', (e, payload = {}) => {
        const result = ai.saveRole(payload);
        if (result.ok) log(`${payload.id ? '修改' : '新增'} AI 提示词角色「${result.role.name}」`);
        return result;
    });

    ipcMain.handle('ai:roles:delete', (e, id) => {
        const role = ai.listRoles().find(r => r.id === id);
        const result = ai.deleteRole(id);
        if (result.ok) log(`删除 AI 提示词角色「${(role || {}).name || id}」`);
        return result;
    });

    /** 用户设定自己的默认角色（面板下拉变更时调用） */
    ipcMain.handle('ai:role:save', (e, { roleId } = {}) => {
        const roles = ai.listRoles();
        const id = String(roleId || '').trim();
        if (id && !roles.some(r => r.id === id)) return { ok: false, message: '角色不存在' };
        ai.saveUserPrefs(operator(), { role: id });
        return { ok: true, role: id };
    });

    /* ---------------- 对话 ---------------- */

    /**
     * 对话：默认流式直答；payload.agent=true 且 Agent 可用时走 function calling 链路
     * steps（工具调用轨迹）经 ai:step 实时推送，不落历史库，仅作为界面过程展示
     */
    ipcMain.handle('ai:chat', async (event, { messages, agent, role } = {}) => {
        const user = operator();
        const list = Array.isArray(messages) ? messages.filter(m => m && typeof m.role === 'string') : [];
        if (!list.length) return { ok: false, message: '消息内容为空' };

        const started = Date.now();
        const send = payload => {
            if (!event.sender.isDestroyed()) event.sender.send(payload.channel || 'ai:stream', payload);
        };
        try {
            // Agent 最终以服务端解析为准：即使前端被篡改也拿不到未授权的 Agent 能力
            const state = ai.agentState(user);
            const useAgent = !!agent && state.enabled;
            // 提示词角色：本次指定 > 用户默认 > 内置通用（roleId 非法时回落，不报错）
            const system = ai.resolveSystem(role, user);

            let text;
            if (useAgent) {
                const out = await ai.chatAgent(list, {
                    model: ai.resolveModel(user),
                    user,
                    system,
                    agent: state.global,
                    onDelta: delta => send({ channel: 'ai:stream', delta }),
                    onStep: step => send({ channel: 'ai:step', ...step })
                });
                text = out.text;
            } else {
                text = await ai.chatStream(list, {
                    model: ai.resolveModel(user),
                    system,
                    onDelta: delta => send({ channel: 'ai:stream', delta })
                });
            }

            pushHistory(user, [
                { role: 'user', content: list[list.length - 1].content || '', at: store.nowText() },
                { role: 'assistant', content: text, at: store.nowText() }
            ]);
            log(`AI ${useAgent ? 'Agent ' : ''}对话（${Math.round((Date.now() - started) / 1000)}s · ${Math.round(text.length / 100) * 100} 字符）`);
            return { ok: true, text, agent: useAgent, durationMs: Date.now() - started };
        } catch (err) {
            log(`AI 对话失败：${err.message}`, 'failed');
            return { ok: false, message: err.message };
        }
    });

    ipcMain.handle('ai:chat:history', () => {
        const session = activeSession(operator());
        return { ok: true, messages: session ? (session.messages || []) : [] };
    });

    ipcMain.handle('ai:chat:clear', () => {
        const user = operator();
        const session = activeSession(user);
        if (session) {
            session.messages = [];
            session.title = '新会话';
            session.updatedAt = store.nowText();
            store.persist();
        }
        log('清空当前 AI 会话');
        return { ok: true };
    });

    /* ---------------- 会话管理（多会话 + 激活指针） ---------------- */

    ipcMain.handle('ai:sessions:list', () => {
        const user = operator();
        const list = sessionsOf(user);
        return {
            ok: true,
            activeId: activeIdOf(user, list),
            sessions: list.map(sessionMeta)
        };
    });

    ipcMain.handle('ai:sessions:new', () => {
        const user = operator();
        const list = sessionsOf(user);
        const session = {
            id: 's_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
            title: '新会话', messages: [],
            createdAt: store.nowText(), updatedAt: store.nowText()
        };
        list.push(session);
        const db = store.load();
        db.aiSessions[user] = list;
        db.aiActive[user] = session.id;
        store.persist();
        log('新建 AI 会话');
        return { ok: true, session: sessionMeta(session) };
    });

    ipcMain.handle('ai:sessions:switch', (e, { id } = {}) => {
        const user = operator();
        const list = sessionsOf(user);
        const session = list.find(s => s.id === id);
        if (!session) return { ok: false, message: '会话不存在或已删除' };
        const db = store.load();
        db.aiActive[user] = session.id;
        store.persist();
        log(`切换 AI 会话：${session.title}`);
        return { ok: true, messages: session.messages || [] };
    });

    ipcMain.handle('ai:sessions:delete', (e, { id } = {}) => {
        const user = operator();
        const list = sessionsOf(user);
        const idx = list.findIndex(s => s.id === id);
        if (idx < 0) return { ok: false, message: '会话不存在或已删除' };
        const [removed] = list.splice(idx, 1);
        const db = store.load();
        db.aiSessions[user] = list;
        if (db.aiActive[user] === id) db.aiActive[user] = list.length ? list[0].id : null;
        store.persist();
        log(`删除 AI 会话：${removed.title}`);
        return { ok: true, activeId: db.aiActive[user] || null };
    });

    /* ---------------- 脚本生成 / 优化 ---------------- */

    /** 提取 AI 回复中的脚本块（``` 代码块） */
    function extractScript(text, type) {
        const fences = String(text || '').match(/```[^\n]*\n([\s\S]*?)```/g);
        if (fences && fences.length) {
            // 取第一个代码块，去掉 ``` 围栏标记
            const code = fences[0].replace(/^```[^\n]*\n/, '').replace(/\n?```$/, '').trim();
            return { script: code, explanation: text.replace(fences[0], '').trim() };
        }
        // 无围栏：整段当脚本
        return { script: String(text || '').trim(), explanation: '' };
    }

    ipcMain.handle('ai:script:generate', async (e, { requirement, type } = {}) => {
        const scriptType = type === 'python' ? 'Python' : 'Shell';
        const req = String(requirement || '').trim();
        if (!req) return { ok: false, message: '请描述脚本需求' };

        const started = Date.now();
        try {
            const { text } = await ai.complete([{
                role: 'user',
                content: `请为内网运维场景生成一个 ${scriptType} 脚本。\n需求：${req}\n要求：只输出脚本本体，必要说明放在脚本后的「说明：」里，不超过 5 条。`
            }]);
            const { script, explanation } = extractScript(text);
            log(`AI 生成脚本（${scriptType}）`, 'success');
            return { ok: true, script, explanation, type: scriptType, durationMs: Date.now() - started };
        } catch (err) {
            log(`AI 生成脚本失败：${err.message}`, 'failed');
            return { ok: false, message: err.message };
        }
    });

    ipcMain.handle('ai:script:optimize', async (e, { name, type, content, hint } = {}) => {
        const scriptType = type === 'python' ? 'Python' : 'Shell';
        const body = String(content || '').trim();
        if (!body) return { ok: false, message: '脚本内容为空' };

        const started = Date.now();
        try {
            const { text } = await ai.complete([{
                role: 'user',
                content: `请优化以下 ${scriptType} 运维脚本「${name || '未命名'}」。\n` +
                    `优化要求：修复潜在问题、提升健壮性（错误处理/参数校验/幂等）、保持原有功能与风格。${hint ? `\n补充诉求：${hint}` : ''}\n\n` +
                    `---- 脚本开始 ----\n${body}\n---- 脚本结束 ----\n\n` +
                    `只输出优化后的完整脚本本体，修改要点放在脚本后的「修改说明：」里，不超过 5 条。`
            }]);
            const { script, explanation } = extractScript(text);
            log(`AI 优化脚本「${name || '-'}」`, 'success');
            return { ok: true, script, explanation, type: scriptType, durationMs: Date.now() - started };
        } catch (err) {
            log(`AI 优化脚本失败：${err.message}`, 'failed');
            return { ok: false, message: err.message };
        }
    });
}

module.exports = { setup };
