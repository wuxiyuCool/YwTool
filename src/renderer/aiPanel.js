/**
 * AI 常驻工作台（右侧 480px 面板，推挤主内容不遮挡）
 *
 * 相比旧版悬浮抽屉的升级点：
 *   1. 常驻工作台：侧边栏渐变入口卡 + Shift+A 唤起，与主内容并排而非遮挡
 *   2. 上下文感知：自动携带当前页面（router.setPage 注入）与选中对象
 *      （如脚本管理页 setTarget 注入的脚本），以系统消息随提问发出，不落历史
 *   3. 会话管理：多会话切换 / 新建 / 删除（ai:sessions:*），清空走面板内
 *      二次确认条，替代原生 confirm
 *   4. 场景化快捷指令：巡检排障 / 生成脚本 / 优化脚本 / 解读日志
 *   5. 结果可落地：AI 回复中的代码块可一键「保存为脚本管理」或复制，
 *      形成 提问 → 优化 → 落库 闭环
 *
 * 权限：ai 模块可见时显示入口；发送需 operator 及以上（写操作）
 */
import { api } from './api.js';
import { esc, toast, canModule } from './ui.js';

let panel = null;
let entryEl = null;
let chatEl = null;
let inputEl = null;
let sendBtn = null;
let quickEl = null;
let ctxEl = null;
let ctxTextEl = null;
let sessionsPopEl = null;
let sessionsListEl = null;
let confirmEl = null;
let modelTagEl = null;
let modelSelEl = null;      // 模型切换下拉
let agentSwitchEl = null;   // Agent 开关
let agentWrapEl = null;
let resizerEl = null;

let visible = false;      // ai 模块对当前账号是否可见
let loaded = false;       // 当前会话是否已加载
let messages = [];        // 本地会话上下文 { role, content }（不含上下文系统消息）
let sending = false;
let streamingEl = null;   // 当前流式气泡
let streamingRaw = '';
let codeStore = {};       // 代码块全局自增 id → 文本（供复制 / 保存读取）
let codeSeq = 0;
let lastRenderIds = [];   // 最近一次 renderContent 生成的代码块 id
let sessions = [];        // 会话元数据列表
let activeSessionId = null;
let context = null;       // { pageId, pageLabel, domainLabel }
let target = null;        // { kind:'script', name, type, desc, content }
let unsubStream = null;
let unsubStep = null;
let agentSupported = false;  // 管理员是否开启了 Agent 总开关
let agentEnabled = false;    // 当前用户本次是否启用 Agent

/* ---------------- Markdown 渲染 ---------------- */

function inlineMarkdown(text) {
    let h = esc(text);
    h = h.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
    h = h.replace(/`([^`]+)`/g, '<code>$1</code>');
    h = h.replace(/\n/g, '<br>');
    return h;
}

function renderContent(text) {
    lastRenderIds = [];
    const parts = String(text || '').split(/```/);
    let out = '';
    for (let i = 0; i < parts.length; i++) {
        if (i % 2 === 1) {
            let block = parts[i];
            let lang = 'code';
            const nl = block.indexOf('\n');
            if (nl >= 0) { lang = block.slice(0, nl).trim() || lang; block = block.slice(nl + 1); }
            const id = ++codeSeq;
            codeStore[id] = block;
            lastRenderIds.push(id);
            out += `<div class="ai-code">
                <div class="ai-code-head"><span>${esc(lang)}</span>
                    <button class="ai-copy" data-code="${id}">复制</button></div>
                <pre><code>${esc(block)}</code></pre>
            </div>`;
        } else {
            out += inlineMarkdown(parts[i]);
        }
    }
    return out;
}

/** 回复中是否含代码块 */
const hasCode = text => String(text || '').split(/```/).length >= 3;

function actionsRow(codeId) {
    return `<div class="ai-msg-actions">
        <button class="ai-chip primary" data-act="save" data-code="${codeId}" title="保存到「脚本管理」">保存为脚本</button>
        <button class="ai-chip" data-act="copy" data-code="${codeId}">复制</button>
    </div>`;
}

function actionsHtml(text) {
    if (!hasCode(text) || !lastRenderIds.length) return '';
    return actionsRow(lastRenderIds[0]);
}

/* ---------------- 消息渲染 ---------------- */

function bubble(role, text, { withActions = false } = {}) {
    const el = document.createElement('div');
    el.className = `ai-msg ${role}`;
    el.innerHTML = `<div class="ai-msg-bubble">${renderContent(text) || ' '}</div>${withActions ? actionsHtml(text) : ''}`;
    if (withActions && lastRenderIds.length) el.dataset.codeId = String(lastRenderIds[0]);
    return el;
}

function paintEmpty() {
    chatEl.innerHTML = '<div class="ai-empty">暂无会话，输入问题或点击下方快捷指令开始</div>';
}

function appendMessage(role, text, { streaming = false } = {}) {
    const el = bubble(role, text, { withActions: role === 'assistant' && !streaming && hasCode(text) });
    chatEl.appendChild(el);
    if (streaming) {
        streamingEl = el;
        streamingRaw = text;
    }
    chatEl.scrollTop = chatEl.scrollHeight;
    return el;
}

function finalizeStreaming(text) {
    if (!streamingEl) return;
    streamingEl.innerHTML =
        `<div class="ai-msg-bubble">${renderContent(text) || ' '}</div>${actionsHtml(text)}`;
    if (lastRenderIds.length) streamingEl.dataset.codeId = String(lastRenderIds[0]);
    finishStreaming();
    chatEl.scrollTop = chatEl.scrollHeight;
}

function updateStreaming(delta) {
    if (!streamingEl) return;
    streamingRaw += delta;
    streamingEl.querySelector('.ai-msg-bubble').innerHTML = renderContent(streamingRaw) || ' ';
    chatEl.scrollTop = chatEl.scrollHeight;
}

function finishStreaming() {
    streamingEl = null;
    streamingRaw = '';
}

/* ---------------- Agent 执行轨迹 ----------------
   工具调用过程以轻量行展示在同一会话里，只做过程可视化：
   - 不写入历史会话（刷新后自然消失）
   - 结论仍由助手最终回复承载
*/

const stepEls = {};

function clearSteps() {
    Object.keys(stepEls).forEach(k => delete stepEls[k]);
    chatEl.querySelectorAll('.ai-step').forEach(el => el.remove());
}

const stepKey = payload => `${payload.round || 0}-${payload.name || 'tool'}`;

function stepSummary(text, max = 90) {
    const s = String(text || '').replace(/\s+/g, ' ').trim();
    return s.length > max ? s.slice(0, max) + '…' : s;
}

function renderStep(payload) {
    // 首个 step 时清掉「暂无会话」占位，避免轨迹被空白挤到可视区外
    const emptyEl = chatEl.querySelector('.ai-empty');
    if (emptyEl) emptyEl.remove();

    if (payload.type === 'call') {
        const key = stepKey(payload);
        const el = document.createElement('div');
        el.className = 'ai-step running';
        el.innerHTML = `<span class="ai-step-dot"></span>
            <span class="ai-step-name">${esc(payload.label || payload.name || '工具')}</span>
            <span class="ai-step-args">${esc(stepSummary(payload.summary))}</span>
            <span class="ai-step-status">执行中…</span>`;
        chatEl.appendChild(el);
        stepEls[key] = el;
        chatEl.scrollTop = chatEl.scrollHeight;
        return;
    }

    const key = stepKey(payload);
    const el = stepEls[key] || chatEl.querySelector('.ai-step.running:last-of-type');
    if (!el) return;
    const ok = !!payload.ok;
    el.classList.remove('running');
    el.classList.add(ok ? 'ok' : 'fail');
    const result = payload.result || {};
    const detail = ok
        ? (result.rowCount !== undefined ? `${result.rowCount} 行` : (result.scriptId ? `${result.name} ${result.version}` : '完成'))
        : (result.error || '失败');
    el.querySelector('.ai-step-status').textContent = detail;
    chatEl.scrollTop = chatEl.scrollHeight;
}

/* ---------------- 上下文感知 ---------------- */

/** router 页面切换时注入（同时清空上一页的选中对象：换页即换上下文） */
export function setPage(ctx) {
    context = ctx || null;
    target = null;
    paintContext();
}

/** 业务页面注入选中对象（如脚本管理页打开编辑弹窗时） */
export function setTarget(t) {
    target = t || null;
    paintContext();
}

function paintContext() {
    if (!ctxEl || !ctxTextEl) return;
    const bits = [];
    if (context) bits.push([context.domainLabel, context.pageLabel].filter(Boolean).join(' › '));
    if (target && target.kind === 'script' && target.name) bits.push(target.name);
    if (!bits.length) { ctxEl.style.display = 'none'; return; }
    ctxEl.style.display = 'flex';
    ctxTextEl.textContent = bits.join(' · ');
}

/** 组装随提问发送的上下文（system 消息，不落本地历史与存储） */
function buildPreamble() {
    const lines = [];
    if (context) {
        const where = [context.domainLabel, context.pageLabel].filter(Boolean).join(' › ');
        lines.push(`【当前界面】${where}`);
    }
    if (target && target.kind === 'script' && target.content) {
        lines.push(`【当前脚本】${target.name || '未命名'}（${target.type === 'python' ? 'Python' : 'Shell'}）内容如下：`);
        lines.push('```' + (target.type === 'python' ? 'python' : 'bash'));
        lines.push(target.content);
        lines.push('```');
    }
    if (!lines.length) return '';
    lines.push('请结合以上界面上下文回答用户问题；给出的命令与脚本需可直接复制执行。');
    return lines.join('\n');
}

/* ---------------- 场景化快捷指令 ---------------- */

const QUICK_COMMANDS = [
    { label: '巡检排障', prompt: '请给出一次快速巡检与排障方案：先列检查项与判定标准，再给可直接执行的命令。', auto: true, needTarget: false },
    { label: '生成脚本', prompt: '请为以下需求生成一个可直接保存的运维脚本（只输出脚本本体与简要说明）：\n', auto: false, needTarget: false },
    { label: '优化脚本', prompt: '请优化当前脚本：指出存在的问题，并给出优化后的完整脚本与修改说明。', auto: true, needTarget: true },
    { label: '解读日志', prompt: '请解读以下日志或命令输出，指出异常点、风险与建议处理：\n', auto: false, needTarget: false }
];

function paintQuick() {
    if (!quickEl) return;
    quickEl.innerHTML = QUICK_COMMANDS.map((c, i) =>
        `<button class="ai-chip" data-idx="${i}">${esc(c.label)}</button>`).join('');
    quickEl.querySelectorAll('.ai-chip').forEach(btn =>
        btn.addEventListener('click', () => {
            const cmd = QUICK_COMMANDS[Number(btn.dataset.idx)];
            if (!cmd) return;
            if (cmd.needTarget && !(target && target.content)) {
                inputEl.value = cmd.prompt;
                inputEl.focus();
                toast('未检测到选中脚本，请补充脚本内容或到「脚本管理」打开一个脚本', 'info');
                return;
            }
            inputEl.value = cmd.prompt;
            if (cmd.auto) send();
            else inputEl.focus();
        }));
}

/* ---------------- 对话 ---------------- */

const usable = () => canModule('ai', 'operator');

async function send() {
    const text = inputEl.value.trim();
    if (!text || sending) return;
    if (!usable()) { toast('当前账号对 AI 助手仅有查看权限，无法对话', 'warn'); return; }

    inputEl.value = '';
    clearSteps();
    appendMessage('user', text);
    const history = [...messages];
    messages = history.concat([{ role: 'user', content: text }]);

    sending = true;
    sendBtn.disabled = true;
    sendBtn.textContent = '生成中…';
    appendMessage('assistant', '', { streaming: true });

    try {
        // 上下文以 system 消息随本次请求发出（不进入本地历史与存储）
        const outbound = [];
        const pre = buildPreamble();
        if (pre) outbound.push({ role: 'system', content: pre });
        outbound.push(...history, { role: 'user', content: text });

        // 流式：delta 由 onAiStream 回填；完整文本在返回值中；Agent 轨迹由 onAiStep 推送
        const res = await api.ai.chat(outbound, agentEnabled);
        if (res && res.ok) {
            messages = messages.concat([{ role: 'assistant', content: res.text }]);
            if (streamingEl) finalizeStreaming(res.text);
        } else {
            const tip = `⚠️ ${(res && res.message) || 'AI 请求失败'}`;
            if (streamingEl) {
                streamingEl.querySelector('.ai-msg-bubble').innerHTML = renderContent(tip) || ' ';
                finishStreaming();
            } else {
                appendMessage('assistant', tip);
            }
        }
    } catch (err) {
        const tip = `⚠️ ${err.message}`;
        if (streamingEl) {
            streamingEl.querySelector('.ai-msg-bubble').innerHTML = renderContent(tip) || ' ';
            finishStreaming();
        } else {
            appendMessage('assistant', tip);
        }
    } finally {
        sending = false;
        sendBtn.disabled = false;
        sendBtn.textContent = '发送';
    }
}

async function loadHistory() {
    try {
        const res = await api.ai.chatHistory();
        if (res && res.ok && Array.isArray(res.messages) && res.messages.length) {
            messages = res.messages.filter(m => m && m.role && m.content);
            chatEl.innerHTML = '';
            messages.forEach(m => appendMessage(m.role, m.content));
        } else {
            messages = [];
            paintEmpty();
        }
    } catch (err) {
        chatEl.innerHTML = '<div class="ai-empty">历史加载失败：' + esc(err.message) + '</div>';
    }
}

/* ---------------- 会话管理 ---------------- */

async function loadSessions() {
    try {
        const res = await api.ai.sessions.list();
        if (res && res.ok) {
            sessions = res.sessions || [];
            activeSessionId = res.activeId || null;
        }
    } catch (err) {
        sessions = [];
        activeSessionId = null;
    }
    renderSessions();
}

function renderSessions() {
    if (!sessionsListEl) return;
    sessionsListEl.innerHTML = sessions.length ? sessions.map(s => `
        <div class="ai-session-item ${s.id === activeSessionId ? 'active' : ''}" data-id="${esc(s.id)}">
            <div class="ai-session-main">
                <strong>${esc(s.title || '新会话')}</strong>
                <span>${esc(String(s.messageCount === undefined ? 0 : s.messageCount))} 条 · ${esc(s.updatedAt || '-')}</span>
            </div>
            <button class="ai-session-del" data-del="${esc(s.id)}" title="删除会话">×</button>
        </div>`).join('') : '<div class="ai-empty">暂无历史会话</div>';
}

function hideSessionsPop() {
    if (sessionsPopEl) sessionsPopEl.classList.remove('open');
}

async function switchSession(id) {
    try {
        const res = await api.ai.sessions.switchTo(id);
        if (res && res.ok) {
            activeSessionId = id;
            messages = (res.messages || []).filter(m => m && m.role && m.content);
            chatEl.innerHTML = '';
            messages.forEach(m => appendMessage(m.role, m.content));
            if (!messages.length) paintEmpty();
            renderSessions();
            hideSessionsPop();
            hideConfirm();
        } else {
            toast((res && res.message) || '切换会话失败', 'warn');
        }
    } catch (err) {
        toast('切换会话失败：' + err.message, 'danger');
    }
}

async function createSession() {
    try {
        const res = await api.ai.sessions.create();
        if (res && res.ok) {
            activeSessionId = res.session.id;
            messages = [];
            paintEmpty();
            await loadSessions();
            hideSessionsPop();
            hideConfirm();
            toast('已新建会话', 'success');
        }
    } catch (err) {
        toast('新建会话失败：' + err.message, 'danger');
    }
}

async function deleteSession(id) {
    try {
        const res = await api.ai.sessions.remove(id);
        if (res && res.ok) {
            if (activeSessionId === id) {
                activeSessionId = res.activeId || null;
                await loadHistory();
            }
            await loadSessions();
            toast('会话已删除', 'success');
        } else {
            toast((res && res.message) || '删除失败', 'warn');
        }
    } catch (err) {
        toast('删除失败：' + err.message, 'danger');
    }
}

/* ---------------- 清空（面板内二次确认，替代原生 confirm） ---------------- */

function showConfirm() {
    hideSessionsPop();
    if (confirmEl) confirmEl.style.display = 'flex';
}

function hideConfirm() {
    if (confirmEl) confirmEl.style.display = 'none';
}

async function clearCurrentSession() {
    try {
        await api.ai.chatClear();
        messages = [];
        paintEmpty();
        hideConfirm();
        await loadSessions();
        toast('当前会话已清空', 'success');
    } catch (err) {
        toast('清空失败：' + err.message, 'danger');
    }
}

/* ---------------- 保存为脚本管理 ---------------- */

const detectExt = code => /#!.*python|^\s*(import|from)\s+\w+/m.test(String(code || '').slice(0, 200)) ? '.py' : '.sh';

function openSaveForm(msgEl) {
    if (!msgEl) return;
    const actionsEl = msgEl.querySelector('.ai-msg-actions');
    if (!actionsEl) return;
    const content = codeStore[msgEl.dataset.codeId] || '';
    const ext = detectExt(content);
    actionsEl.outerHTML = `<div class="ai-save-form">
        <div class="ai-save-row">
            <input class="input mono" data-f="name" value="ai_${Date.now().toString(36)}${ext}" placeholder="脚本名">
            <select class="select" data-f="type">
                <option value="shell"${ext === '.sh' ? ' selected' : ''}>Shell</option>
                <option value="python"${ext === '.py' ? ' selected' : ''}>Python</option>
            </select>
        </div>
        <input class="input" data-f="desc" placeholder="脚本描述（可选）">
        <div class="ai-save-actions">
            <button class="btn btn-primary btn-sm" data-act="save-confirm">保存到脚本管理</button>
            <button class="btn btn-ghost btn-sm" data-act="save-cancel">取消</button>
        </div>
    </div>`;
    const nameInput = msgEl.querySelector('.ai-save-form [data-f="name"]');
    if (nameInput) { nameInput.focus(); nameInput.select(); }
}

async function submitSaveForm(msgEl) {
    const form = msgEl.querySelector('.ai-save-form');
    if (!form) return;
    const name = form.querySelector('[data-f="name"]').value.trim();
    const type = form.querySelector('[data-f="type"]').value;
    const desc = form.querySelector('[data-f="desc"]').value.trim();
    const content = codeStore[msgEl.dataset.codeId] || '';

    if (!name) { toast('请填写脚本名', 'warn'); return; }
    if (!content.trim()) { toast('脚本内容为空', 'warn'); return; }
    if (!canModule('scripts', 'operator')) {
        toast('保存为脚本需要「脚本管理」模块的可写权限', 'warn');
        return;
    }

    const res = await api.scripts.save({ name, type, desc, content });
    if (res && res.ok) {
        form.outerHTML = `<div class="ai-saved-note">已保存为脚本 ${esc(name)}（${esc(res.script.version || 'v1')}），可到「脚本管理」查看与执行</div>`;
        toast('已保存到脚本管理', 'success');
    } else {
        toast((res && res.message) || '保存失败', 'danger');
    }
}

function restoreActions(msgEl) {
    const form = msgEl.querySelector('.ai-save-form');
    if (!form) return;
    form.outerHTML = actionsRow(msgEl.dataset.codeId);
}

function copyCode(codeId) {
    const code = codeStore[codeId];
    navigator.clipboard.writeText(code || '')
        .then(() => toast('已复制', 'success'))
        .catch(() => toast('复制失败', 'danger'));
}

/* ---------------- 显隐与生命周期 ---------------- */

function toggle(force) {
    if (!panel) return;
    const open = force !== undefined ? !!force : !panel.classList.contains('open');
    panel.classList.toggle('open', open);
    if (entryEl) entryEl.classList.toggle('active', open);
    if (!open) {
        hideSessionsPop();
        hideConfirm();
        // 收起时必须把内联宽度归零，否则会覆盖 CSS 的 width: 0
        panel.style.width = '0px';
    }
    if (open) {
        applyWidth(savedWidth());
        hideSessionsPop();
        inputEl.focus();
        if (!loaded) { loaded = true; loadHistory(); }
    }
}

/* ---------------- 模型切换 / Agent 开关 ---------------- */

/** 渲染模型下拉：按提供方分组，含当前生效模型 */
function paintModels(info) {
    if (!modelSelEl) return;
    const current = info.model || info.defaultModel || '';
    const groups = [];
    (info.providers || []).forEach(p => {
        const models = [].concat(p.models || [], p.model ? [p.model] : []);
        const unique = [...new Set(models.filter(Boolean))];
        if (unique.length) groups.push({ label: p.label, models: unique });
    });
    // 生效模型不在预设清单里（自定义模型）也补一项，避免下拉显示错乱
    if (current && !groups.some(g => g.models.includes(current))) {
        groups.unshift({ label: '当前生效', models: [current] });
    }
    modelSelEl.innerHTML = groups.map(g =>
        `<optgroup label="${esc(g.label)}">${g.models.map(m =>
            `<option value="${esc(m)}"${m === current ? ' selected' : ''}>${esc(m)}</option>`).join('')}</optgroup>`).join('');
    modelSelEl.title = `当前模型：${current}`;
}

async function loadModels() {
    try {
        const res = await api.ai.model.get();
        if (!res || !res.ok) return;
        paintModels(res);
        if (modelTagEl && res.provider) {
            const provider = (res.providers || []).find(p => p.id === res.provider);
            modelTagEl.textContent = (provider && provider.label) || res.provider;
            modelTagEl.style.display = '';
        }
    } catch (err) { /* 静默：仅为辅助展示 */ }
}

async function switchModel(model) {
    try {
        const res = await api.ai.model.save(model);
        if (res && res.ok) {
            if (modelTagEl) modelTagEl.textContent = model;
            toast(`已切换到模型 ${model}`, 'success');
        } else {
            toast((res && res.message) || '模型切换失败', 'warn');
            await loadModels();
        }
    } catch (err) {
        toast('模型切换失败：' + err.message, 'danger');
        await loadModels();
    }
}

async function loadAgent() {
    try {
        const res = await api.ai.agent.get();
        if (!res || !res.ok) return;
        const globalOn = !!(res.global && res.global.enabled);
        agentSupported = globalOn;
        agentEnabled = !!res.enabled;
        paintAgent();
    } catch (err) {
        agentSupported = false;
        agentEnabled = false;
        paintAgent();
    }
}

function paintAgent() {
    if (agentSwitchEl) {
        agentSwitchEl.checked = agentEnabled && agentSupported;
        agentSwitchEl.disabled = !agentSupported;
    }
    if (agentWrapEl) {
        agentWrapEl.classList.toggle('disabled', !agentSupported);
        agentWrapEl.title = agentSupported
            ? 'Agent 已可用：AI 可调用平台工具完成任务（查询主机 / 生成数据 / 保存脚本 / 执行命令 / 查询数据源）'
            : 'Agent 总开关未开启，请联系系统管理员在「系统运维 → AI 配置」中启用';
    }
}

async function toggleAgent(enabled) {
    if (!agentSupported) {
        toast('Agent 总开关未开启，请联系系统管理员在「AI 配置」中启用', 'warn');
        paintAgent();
        return;
    }
    try {
        const res = await api.ai.agent.toggle(enabled);
        if (res && res.ok) {
            agentEnabled = !!res.enabled;
            toast(agentEnabled ? 'Agent 已开启：AI 将调用平台工具完成任务' : 'Agent 已关闭', agentEnabled ? 'success' : 'info');
        } else {
            toast((res && res.message) || 'Agent 开关切换失败', 'warn');
        }
    } catch (err) {
        toast('Agent 开关切换失败：' + err.message, 'danger');
    }
    paintAgent();
}

function bindEvents() {
    sendBtn.addEventListener('click', send);
    if (modelSelEl) modelSelEl.addEventListener('change', () => switchModel(modelSelEl.value));
    if (agentSwitchEl) agentSwitchEl.addEventListener('change', () => toggleAgent(agentSwitchEl.checked));
    inputEl.addEventListener('keydown', e => {
        if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(); }
    });
    panel.querySelector('#ai-close').addEventListener('click', () => toggle(false));
    panel.querySelector('#ai-clear').addEventListener('click', showConfirm);
    panel.querySelector('#ai-confirm-yes').addEventListener('click', clearCurrentSession);
    panel.querySelector('#ai-confirm-no').addEventListener('click', hideConfirm);
    panel.querySelector('#ai-context-close').addEventListener('click', () => {
        target = null;
        paintContext();
    });

    const sessionsBtn = panel.querySelector('#ai-sessions');
    sessionsBtn.addEventListener('click', async e => {
        e.stopPropagation();
        const open = !sessionsPopEl.classList.contains('open');
        if (open) { hideConfirm(); await loadSessions(); }
        sessionsPopEl.classList.toggle('open', open);
    });
    panel.querySelector('#ai-session-new').addEventListener('click', createSession);

    sessionsListEl.addEventListener('click', e => {
        const del = e.target.closest('.ai-session-del');
        if (del) {
            // 两段式删除：第一次点击进入确认态
            if (del.dataset.armed !== '1') {
                del.dataset.armed = '1';
                del.textContent = '确认删除';
                del.classList.add('armed');
                setTimeout(() => {
                    if (del.isConnected) { del.dataset.armed = ''; del.textContent = '×'; del.classList.remove('armed'); }
                }, 2600);
            } else {
                deleteSession(del.dataset.del);
            }
            return;
        }
        const item = e.target.closest('.ai-session-item');
        if (item) switchSession(item.dataset.id);
    });

    // 点击面板其他区域收起会话弹层
    panel.addEventListener('click', e => {
        if (!sessionsPopEl.classList.contains('open')) return;
        if (e.target.closest('#ai-sessions-pop') || e.target.closest('#ai-sessions')) return;
        hideSessionsPop();
    });

    // 对话区：代码块复制 / 消息级操作（保存为脚本、复制、保存表单）
    chatEl.addEventListener('click', e => {
        const copyBtn = e.target.closest('.ai-copy');
        if (copyBtn) { copyCode(copyBtn.dataset.code); return; }
        const act = e.target.closest('[data-act]');
        if (!act) return;
        const msgEl = act.closest('.ai-msg');
        switch (act.dataset.act) {
            case 'copy': copyCode(act.dataset.code || (msgEl && msgEl.dataset.codeId)); break;
            case 'save': openSaveForm(msgEl); break;
            case 'save-confirm': submitSaveForm(msgEl); break;
            case 'save-cancel': restoreActions(msgEl); break;
        }
    });

    // 侧边栏入口卡
    if (entryEl) entryEl.addEventListener('click', () => toggle());

    // Shift+A 全局快捷键（输入状态下不触发）
    document.addEventListener('keydown', e => {
        if (!visible || !panel) return;
        if (!e.shiftKey || e.ctrlKey || e.altKey || e.metaKey) return;
        if (String(e.key).toLowerCase() !== 'a') return;
        const t = e.target;
        if (t && (/(INPUT|TEXTAREA|SELECT)/.test(t.tagName) || t.isContentEditable)) return;
        e.preventDefault();
        toggle();
    });

    // 流式订阅（仅订阅一次）
    if (typeof api.onAiStream === 'function' && !unsubStream) {
        unsubStream = api.onAiStream(({ delta }) => { if (delta) updateStreaming(delta); });
    }
    // Agent 工具执行轨迹订阅
    if (typeof api.onAiStep === 'function' && !unsubStep) {
        unsubStep = api.onAiStep(payload => { if (payload) renderStep(payload); });
    }

    bindResizer();
}

/* ---------------- 面板宽度（拖拽 + 记忆） ----------------
   旧实现把面板宽度写死为 480px 且子元素锁死 min-width:479px，
   窄窗口下面板会被挤出可视区（显示不全）。改为可拖拽 + 本地记忆宽度，
   真正由用户决定主内容与工作台的占比。
*/

const WIDTH_KEY = 'sgops.aiPanelWidth';
const MIN_WIDTH = 300;
const MAX_WIDTH = 720;
const DEFAULT_WIDTH = 440;

function savedWidth() {
    const raw = Number(localStorage.getItem(WIDTH_KEY));
    if (!Number.isFinite(raw) || raw < MIN_WIDTH || raw > MAX_WIDTH) return DEFAULT_WIDTH;
    return raw;
}

function applyWidth(px) {
    if (!panel) return;
    panel.style.width = `${px}px`;
}

function bindResizer() {
    if (!resizerEl || !panel) return;
    let dragging = false;
    const onMove = e => {
        if (!dragging) return;
        const parentRect = panel.parentElement.getBoundingClientRect();
        // 向左拖 = 变宽；同时给主内容区留 360px 底线，避免把页面挤没
        const ceiling = Math.min(MAX_WIDTH, Math.max(MIN_WIDTH, parentRect.width - 360));
        const raw = Math.min(Math.max(parentRect.right - e.clientX, MIN_WIDTH), ceiling);
        const width = Math.min(raw, MAX_WIDTH);
        applyWidth(width);
    };
    const onUp = () => {
        if (!dragging) return;
        dragging = false;
        document.body.classList.remove('ai-resizing');
        const width = Math.min(Math.max(parseInt(panel.style.width, 10) || DEFAULT_WIDTH, MIN_WIDTH), MAX_WIDTH);
        localStorage.setItem(WIDTH_KEY, String(width));
        window.removeEventListener('mousemove', onMove);
        window.removeEventListener('mouseup', onUp);
    };

    resizerEl.addEventListener('mousedown', e => {
        e.preventDefault();
        dragging = true;
        document.body.classList.add('ai-resizing');
        window.addEventListener('mousemove', onMove);
        window.addEventListener('mouseup', onUp);
    });

    // 双击恢复默认宽度
    resizerEl.addEventListener('dblclick', () => {
        localStorage.removeItem(WIDTH_KEY);
        applyWidth(DEFAULT_WIDTH);
        toast('已恢复 AI 工作台默认宽度', 'info');
    });
}

/** 初始化：在 ai 模块对当前账号可见时调用（bootstrap 流程） */
export function init() {
    visible = canModule('ai', 'viewer');
    if (!visible) return;

    if (panel) {
        // 重复初始化（如退出后重新登录）：仅需保证入口卡可见
        if (entryEl) entryEl.style.display = '';
        return;
    }

    panel = document.getElementById('ai-panel');
    entryEl = document.getElementById('ai-entry');
    if (entryEl) entryEl.style.display = visible ? '' : 'none';
    chatEl = panel.querySelector('#ai-chat');
    inputEl = panel.querySelector('#ai-input');
    sendBtn = panel.querySelector('#ai-send');
    quickEl = panel.querySelector('#ai-quick');
    ctxEl = panel.querySelector('#ai-context');
    ctxTextEl = panel.querySelector('#ai-context-text');
    sessionsPopEl = panel.querySelector('#ai-sessions-pop');
    sessionsListEl = panel.querySelector('#ai-sessions-list');
    confirmEl = panel.querySelector('#ai-confirm');
    modelTagEl = panel.querySelector('#ai-model-tag');
    modelSelEl = panel.querySelector('#ai-model-select');
    agentSwitchEl = panel.querySelector('#ai-agent-switch');
    agentWrapEl = panel.querySelector('#ai-agent-wrap');
    resizerEl = panel.querySelector('#ai-resizer');

    bindEvents();
    paintQuick();
    paintContext();
    paintAgent();
    loadModels();
    loadAgent();

    // 常驻工作台：默认展开（可手动收起，Shift+A 随时唤回）
    loaded = true;
    panel.classList.add('open');
    applyWidth(savedWidth());
    if (entryEl) entryEl.classList.add('active');
    loadHistory();
    loadSessions();
}

/** 权限变化时调用：按 ai 模块可见性显隐入口与面板 */
export function refresh() {
    visible = canModule('ai', 'viewer');
    if (entryEl) entryEl.style.display = visible ? '' : 'none';
    if (!visible) {
        if (panel) panel.classList.remove('open');
        messages = [];
        return;
    }
    if (!panel) return;   // 尚未初始化（bootstrap 会调 init）
    if (!panel.classList.contains('open') && !loaded) loadHistory();
}
