/**
 * 系统运维 · 备份与密钥
 * 数据流：system:backup:export|import（口令加密信封）
 *        system:secrets:status|template|encrypt（外置密钥注入）
 *        system:config:save（secretsAutoSync 开关）
 */
import { api, demoMode } from '../api.js';
import { toast, demoBanner, applyReadonly, guardAdmin } from '../ui.js';

export function render() {
    return `
    ${demoBanner(demoMode)}
    <div class="card">
        <div class="card-header">
            <div>
                <div class="card-title">备份与迁移</div>
                <div class="card-desc">配置全量导出为口令加密文件（scrypt + AES-256-GCM）；密文信封可安全存放，忘记口令无法恢复</div>
            </div>
        </div>
        <div class="grid-2">
            <div>
                <div class="form-item">
                    <label>备份口令（至少 8 位）</label>
                    <input class="input" type="password" id="bk-export-pass" autocomplete="new-password" placeholder="用于加密备份文件，导入时需要输入">
                </div>
                <div class="form-item">
                    <label>确认口令</label>
                    <input class="input" type="password" id="bk-export-pass2" autocomplete="new-password">
                </div>
                <label class="check-item"><input type="checkbox" id="bk-include-users" checked>
                    <div><strong>包含用户与权限矩阵</strong><span class="muted" style="font-size:11.5px">登录口令为 scrypt 哈希，可跨机恢复</span></div>
                </label>
                <label class="check-item"><input type="checkbox" id="bk-include-history">
                    <div><strong>包含执行历史</strong><span class="muted" style="font-size:11.5px">任务 / SQL / ETL 记录与告警（体积较大，默认不含）</span></div>
                </label>
                <div class="toolbar" style="margin-top:14px">
                    <button class="btn btn-primary" data-write id="btn-bk-export">导出备份…</button>
                    <span class="muted" id="bk-export-msg" style="font-size:12px"></span>
                </div>
            </div>
            <div>
                <div class="form-item">
                    <label>备份口令</label>
                    <input class="input" type="password" id="bk-import-pass" autocomplete="off" placeholder="输入导出时设置的口令">
                </div>
                <div class="form-item">
                    <label>导入模式</label>
                    <select class="select" id="bk-import-mode" style="width:100%">
                        <option value="merge">合并（同 id 覆盖，其余追加）</option>
                        <option value="replace">替换（集合整体覆盖）</option>
                    </select>
                    <div class="form-hint">导入前会自动保留当前库快照（.pre-import-*），出问题可手工回退</div>
                </div>
                <div class="alert warn" style="margin:6px 0 0">
                    <span>「替换」会覆盖主机 / 数据源 / 账号等同名集合，执行前请确认。</span>
                </div>
                <div class="toolbar" style="margin-top:14px">
                    <button class="btn btn-danger" data-write id="btn-bk-import">选择备份文件并导入…</button>
                    <span class="muted" id="bk-import-msg" style="font-size:12px"></span>
                </div>
            </div>
        </div>
    </div>

    <div class="card">
        <div class="card-header">
            <div>
                <div class="card-title">外置密钥配置</div>
                <div class="card-desc">敏感数据（AI apiKey、库/主机/台账口令）可由 gitignore 的外置文件注入，不写死在程序与本机密库；修改后自动生效无需重启</div>
            </div>
            <span class="badge gray" id="sk-state">检查中</span>
        </div>
        <div class="form-item">
            <label>当前生效文件</label>
            <input class="input mono" id="sk-file" readonly placeholder="—">
            <div class="form-hint">查找顺序：环境变量 SGOPS_SECRETS_FILE → 程序 exe 同目录 sgops.secrets.json（便携外挂） → 数据目录 sgops.secrets.json；键格式：db:源ID / host:主机ID / docker:端点ID / ledger:条目ID / acc:账号ID</div>
        </div>
        <label class="check-item" style="margin-bottom:12px">
            <input type="checkbox" id="sk-autosync">
            <div><strong>自动同步</strong><span class="muted" style="font-size:11.5px">在应用内保存/删除凭据时，自动写入或移除外置文件的对应键（v1: 本机密文，仅本机可解）</span></div>
        </label>
        <div class="toolbar">
            <button class="btn btn-ghost btn-sm" data-write id="btn-sk-refresh">刷新状态</button>
            <button class="btn btn-primary btn-sm" data-write id="btn-sk-template">生成模板文件</button>
            <span class="muted" id="sk-msg" style="font-size:12px"></span>
        </div>
        <div class="form-item" style="margin-top:10px">
            <label>加密工具（明文 → v1: 本机密文，粘贴进外置文件即可避免明文落盘）</label>
            <div class="toolbar" style="margin:0">
                <input class="input" id="sk-plain" type="password" placeholder="输入要加密的密钥/口令" style="max-width:320px">
                <button class="btn btn-ghost btn-sm" data-write id="btn-sk-encrypt">加密</button>
            </div>
            <textarea class="textarea mono" id="sk-cipher" rows="2" readonly placeholder="生成的 v1:... 密文会显示在这里（仅本机可解密）" style="margin-top:8px;font-size:11.5px"></textarea>
        </div>
    </div>`;
}

export async function mount(root) {
    /* ---------------- 备份与迁移 ---------------- */

    root.querySelector('#btn-bk-export').addEventListener('click', async () => {
        if (!guardAdmin('导出配置备份')) return;
        const pass = root.querySelector('#bk-export-pass').value;
        const pass2 = root.querySelector('#bk-export-pass2').value;
        const msg = root.querySelector('#bk-export-msg');
        if (pass.length < 8) { toast('备份口令至少 8 位', 'warn'); return; }
        if (pass !== pass2) { toast('两次输入的口令不一致', 'warn'); return; }
        msg.textContent = '加密导出中...';
        const res = await api.system.backup.export({
            passphrase: pass,
            includeUsers: root.querySelector('#bk-include-users').checked,
            includeHistory: root.querySelector('#bk-include-history').checked
        });
        if (res && res.ok) {
            msg.textContent = `已导出：${res.filePath}`;
            toast('备份文件已加密导出', 'success');
        } else if (res && !res.canceled) {
            msg.textContent = '';
            toast((res && res.message) || '导出失败', 'danger');
        } else {
            msg.textContent = '';
        }
    });

    root.querySelector('#btn-bk-import').addEventListener('click', async () => {
        if (!guardAdmin('导入配置备份')) return;
        const pass = root.querySelector('#bk-import-pass').value;
        const mode = root.querySelector('#bk-import-mode').value;
        const msg = root.querySelector('#bk-import-msg');
        if (!pass) { toast('请输入备份口令', 'warn'); return; }
        if (mode === 'replace' && !confirm('「替换」模式将整体覆盖同名配置集合，确认继续？')) return;
        msg.textContent = '解密校验中...';
        const res = await api.system.backup.import({ passphrase: pass, mode });
        if (res && res.ok) {
            const total = Object.values(res.counts || {}).reduce((a, b) => a + b, 0);
            msg.textContent = `已导入 ${total} 条（备份生成于 ${res.createdAt || '-'}）`;
            toast('备份导入完成', 'success');
            root.querySelector('#bk-import-pass').value = '';
            await refreshSecrets();
        } else if (res && !res.canceled) {
            msg.textContent = '';
            toast((res && res.message) || '导入失败', 'danger');
        } else {
            msg.textContent = '';
        }
    });

    /* ---------------- 外置密钥配置 ---------------- */

    async function refreshSecrets() {
        const badge = root.querySelector('#sk-state');
        const fileEl = root.querySelector('#sk-file');
        try {
            const s = await api.system.secrets.status();
            if (!s || !s.ok) { badge.textContent = '不可用'; badge.className = 'badge gray'; return; }
            fileEl.value = s.file || '';
            root.querySelector('#sk-autosync').checked = s.autoSync !== false;
            if (s.error) {
                badge.textContent = '解析错误'; badge.className = 'badge red';
            } else if (s.exists && s.count > 0) {
                badge.textContent = `已注入 ${s.count} 项` + (s.aiKeys && s.aiKeys.length ? ' · 含 AI' : '');
                badge.className = 'badge green';
            } else if (s.exists) {
                badge.textContent = '文件存在（未填值）'; badge.className = 'badge amber';
            } else {
                badge.textContent = '未启用'; badge.className = 'badge gray';
            }
        } catch (err) {
            badge.textContent = '查询失败'; badge.className = 'badge red';
        }
    }

    root.querySelector('#btn-sk-refresh').addEventListener('click', refreshSecrets);

    root.querySelector('#sk-autosync').addEventListener('change', async e => {
        if (!guardAdmin('切换自动同步')) { e.target.checked = !e.target.checked; return; }
        const res = await api.system.saveConfig({ secretsAutoSync: e.target.checked });
        if (res && res.ok) toast(e.target.checked ? '已开启凭据自动同步' : '已关闭自动同步', 'success');
        else { e.target.checked = !e.target.checked; toast('保存失败', 'danger'); }
    });

    root.querySelector('#btn-sk-template').addEventListener('click', async () => {
        if (!guardAdmin('生成外置密钥模板')) return;
        const msg = root.querySelector('#sk-msg');
        msg.textContent = '生成中...';
        const res = await api.system.secrets.template();
        if (res && res.ok) {
            msg.textContent = res.created ? `已创建：${res.file}` : (res.message || '文件已存在');
            toast(res.created ? '模板已生成，编辑该文件注入密钥' : '文件已存在，未覆盖', res.created ? 'success' : 'info');
            await refreshSecrets();
        } else {
            msg.textContent = '';
            toast((res && res.message) || '生成失败', 'danger');
        }
    });

    root.querySelector('#btn-sk-encrypt').addEventListener('click', async () => {
        if (!guardAdmin('加密外置密钥')) return;
        const plain = root.querySelector('#sk-plain').value;
        if (!plain) { toast('请输入要加密的内容', 'warn'); return; }
        const res = await api.system.secrets.encrypt(plain);
        if (res && res.ok) {
            root.querySelector('#sk-cipher').value = res.cipher;
            root.querySelector('#sk-plain').value = '';
            toast('已生成密文，粘贴到外置文件对应键即可', 'success');
        } else {
            toast((res && res.message) || '加密失败', 'danger');
        }
    });

    await refreshSecrets();
    applyReadonly(root);
}
