/**
 * 敏感词配置页
 * 数据流：rules:list / rules:save / rules:delete / rules:toggle
 * 规则变更即时生效于任务执行前的预校验（security.validate）
 */
import { api, demoMode } from '../api.js';
import { esc, toast, demoBanner, emptyRow, loadingRow, applyReadonly } from '../ui.js';

let rules = [];
let editingId = null;

const levelBadge = lv =>
    lv === '高危' ? '<span class="badge red">高危</span>'
    : lv === '中危' ? '<span class="badge amber">中危</span>'
    : '<span class="badge gray">低危</span>';

const modeBadge = m => m === 'blacklist'
    ? '<span class="badge blue">黑名单 · 命中即拦</span>'
    : '<span class="badge green">白名单 · 免校验</span>';

function rowHtml(r) {
    return `
    <tr data-id="${esc(r.id)}">
        <td class="mono">${esc(r.pattern)}</td>
        <td>${esc(r.desc)}</td>
        <td>${levelBadge(r.level)}</td>
        <td>${modeBadge(r.mode)}</td>
        <td>${esc(r.hits || 0)}</td>
        <td>
            <label class="switch">
                <input type="checkbox" data-toggle="${esc(r.id)}" ${r.enabled ? 'checked' : ''} data-write>
                <span class="track"></span>
            </label>
        </td>
        <td style="white-space:nowrap">
            <button class="btn-link" data-act="edit" data-write>编辑</button>
            <button class="btn-link danger" data-act="delete" data-write>删除</button>
        </td>
    </tr>`;
}

export function render() {
    return `
    ${demoBanner(demoMode)}
    <div class="stat-grid">
        <div class="stat-card">
            <div class="stat-info">
                <div class="stat-label">生效规则</div>
                <div class="stat-value" id="stat-enabled">-</div>
                <div class="stat-sub" id="stat-split">黑名单 - · 白名单 -</div>
            </div>
            <div class="stat-icon blue"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 3l8 3v6c0 5-3.5 8-8 9-4.5-1-8-4-8-9V6l8-3z"/></svg></div>
        </div>
        <div class="stat-card">
            <div class="stat-info">
                <div class="stat-label">今日拦截</div>
                <div class="stat-value" id="stat-blocked">-</div>
                <div class="stat-sub" id="stat-today">今日审计记录 - 条</div>
            </div>
            <div class="stat-icon red"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg></div>
        </div>
    </div>

    <div class="card">
        <div class="card-header">
            <div>
                <div class="card-title">规则库</div>
                <div class="card-desc">正则黑名单命中即拦截并留痕，白名单命中跳过校验；修改后立即生效</div>
            </div>
            <div style="display:flex;gap:8px">
                <button class="btn btn-ghost btn-sm" id="btn-refresh-rules">刷新</button>
                <button class="btn btn-primary" id="btn-add-rule" data-write>+ 添加规则</button>
            </div>
        </div>
        <div class="table-wrap">
            <table class="table">
                <thead><tr><th>正则表达式</th><th>描述</th><th>级别</th><th>类型</th><th>命中次数</th><th>启用</th><th>操作</th></tr></thead>
                <tbody id="rule-tbody">${loadingRow(7)}</tbody>
            </table>
        </div>
    </div>

    <div class="card">
        <div class="card-header">
            <div>
                <div class="card-title">即时测试</div>
                <div class="card-desc">输入命令，立即查看会命中哪些规则（不产生执行行为，但会写入审计）</div>
            </div>
        </div>
        <textarea class="textarea" id="test-cmd" rows="2" placeholder="例如：rm -rf /var/log">rm -rf /var/log</textarea>
        <div class="toolbar" style="margin:12px 0 0">
            <button class="btn btn-ghost" id="btn-test-rule">测试命中情况</button>
        </div>
        <div id="test-result"></div>
    </div>

    <div class="modal-mask" id="rule-modal">
        <div class="modal">
            <div class="modal-header">
                <h3 id="rule-modal-title">添加拦截规则</h3>
                <button class="modal-close" data-close>×</button>
            </div>
            <div class="modal-body">
                <div class="form-item">
                    <label>正则表达式</label>
                    <input class="input mono" id="r-pattern" placeholder="rm\\s+-rf\\s+/">
                </div>
                <div class="form-item">
                    <label>规则描述</label>
                    <input class="input" id="r-desc" placeholder="递归强制删除根路径">
                </div>
                <div class="form-row">
                    <div class="form-item">
                        <label>危险级别</label>
                        <select class="select" id="r-level" style="width:100%">
                            <option>高危</option><option>中危</option><option>低危</option>
                        </select>
                    </div>
                    <div class="form-item">
                        <label>规则类型</label>
                        <select class="select" id="r-mode" style="width:100%">
                            <option value="blacklist">黑名单（命中拦截）</option>
                            <option value="whitelist">白名单（免校验）</option>
                        </select>
                    </div>
                </div>
            </div>
            <div class="modal-footer">
                <button class="btn btn-ghost" data-close>取消</button>
                <button class="btn btn-primary" id="rule-save">保存</button>
            </div>
        </div>
    </div>`;
}

export async function mount(root) {
    const tbody = root.querySelector('#rule-tbody');
    const modal = root.querySelector('#rule-modal');

    const paintStats = async () => {
        const enabled = rules.filter(r => r.enabled);
        root.querySelector('#stat-enabled').textContent = enabled.length;
        root.querySelector('#stat-split').textContent =
            `黑名单 ${enabled.filter(r => r.mode === 'blacklist').length} · 白名单 ${enabled.filter(r => r.mode === 'whitelist').length}`;
        try {
            const stats = await api.audit.stats();
            root.querySelector('#stat-blocked').textContent = stats.todayBlocked;
            root.querySelector('#stat-today').textContent = `今日审计记录 ${stats.todayTotal} 条`;
        } catch (err) { /* 忽略统计失败 */ }
    };

    const refresh = async () => {
        try {
            rules = await api.rules.list();
            tbody.innerHTML = rules.length ? rules.map(rowHtml).join('') : emptyRow(7, '暂无规则');
            await paintStats();
        } catch (err) {
            tbody.innerHTML = emptyRow(7, '规则加载失败：' + err.message);
        }
    };

    const openModal = (rule) => {
        editingId = rule ? rule.id : null;
        root.querySelector('#rule-modal-title').textContent = rule ? '编辑拦截规则' : '添加拦截规则';
        root.querySelector('#r-pattern').value = rule ? rule.pattern : '';
        root.querySelector('#r-desc').value = rule ? rule.desc : '';
        root.querySelector('#r-level').value = rule ? rule.level : '高危';
        root.querySelector('#r-mode').value = rule ? rule.mode : 'blacklist';
        modal.classList.add('open');
    };

    root.querySelector('#btn-add-rule').addEventListener('click', () => openModal(null));
    root.querySelector('#btn-refresh-rules').addEventListener('click', refresh);
    modal.querySelectorAll('[data-close]').forEach(el => el.addEventListener('click', () => modal.classList.remove('open')));

    // 启用 / 停用（即时落库）
    tbody.addEventListener('change', async e => {
        const input = e.target.closest('[data-toggle]');
        if (!input) return;
        const res = await api.rules.toggle(input.dataset.toggle, input.checked);
        if (res && res.ok) {
            const rule = rules.find(r => r.id === input.dataset.toggle);
            if (rule) rule.enabled = input.checked;
            toast(`规则已${input.checked ? '启用' : '停用'}`, 'success');
            await paintStats();
        } else {
            input.checked = !input.checked;
            toast((res && res.message) || '操作失败', 'danger');
        }
    });

    // 编辑 / 删除
    tbody.addEventListener('click', async e => {
        const btn = e.target.closest('[data-act]');
        if (!btn) return;
        const id = btn.closest('tr').dataset.id;
        const rule = rules.find(r => r.id === id);

        if (btn.dataset.act === 'edit') {
            openModal(rule);
        } else if (btn.dataset.act === 'delete') {
            if (!confirm(`确认删除规则「${rule.desc}」？`)) return;
            const res = await api.rules.remove(id);
            if (res && res.ok) { toast('规则已删除', 'success'); await refresh(); }
            else toast('删除失败', 'danger');
        }
    });

    // 保存规则
    root.querySelector('#rule-save').addEventListener('click', async () => {
        const payload = {
            id: editingId || undefined,
            pattern: root.querySelector('#r-pattern').value.trim(),
            desc: root.querySelector('#r-desc').value.trim(),
            level: root.querySelector('#r-level').value,
            mode: root.querySelector('#r-mode').value,
            enabled: true
        };
        if (!payload.pattern) { toast('请输入正则表达式', 'warn'); return; }
        try { new RegExp(payload.pattern); } catch (err) { toast('正则语法错误：' + err.message, 'danger'); return; }

        const res = await api.rules.save(payload);
        if (res && res.ok) {
            toast('规则已保存并生效', 'success');
            modal.classList.remove('open');
            await refresh();
        } else {
            toast((res && res.message) || '保存失败', 'danger');
        }
    });

    // 即时测试
    root.querySelector('#btn-test-rule').addEventListener('click', async () => {
        const cmd = root.querySelector('#test-cmd').value;
        const res = await api.rules.validate(cmd);
        root.querySelector('#test-result').innerHTML = `
            <div class="alert ${res.blocked ? 'danger' : 'success'}">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">${res.blocked
                    ? '<circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/>'
                    : '<polyline points="20 6 9 17 4 12"/>'}</svg>
                <span>${esc(res.reason || res.message || '')}</span>
            </div>`;
        await refresh();
    });

    await refresh();
    applyReadonly(root);
}
