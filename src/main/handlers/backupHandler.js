/**
 * 配置备份与迁移 IPC（系统运维域 · settings 模块 · 仅系统管理员）
 * 通道：system:backup:export / system:backup:import
 *
 * 设计目标：把散落在本地库（sgops.json）中的配置打包成单文件，供换机迁移 / 版本回滚。
 * 安全约束：备份文件可能被随手放进仓库目录，因此整个备份以「用户口令派生密钥」加密：
 *   - KDF：scrypt(N=16384, r=8, p=1) → AES-256 密钥（口令不出本机、不落盘）
 *   - 加密：AES-256-GCM（认证加密，口令错误或文件篡改都会解密失败）
 *   - 库内的凭据在导出时解密为明文进入加密信封，导入时用本机密钥重新加密，
 *     因此备份可以恢复到另一台机器（本机 .secret.key 与备份无关）
 * 文件本身是 JSON 信封（format=sgops-backup），但 payload 为密文，可直接提交/传输。
 */
const fs = require('fs');
const crypto = require('crypto');
const { dialog } = require('electron');
const store = require('../store');
const audit = require('../auditLogger');
const auth = require('../auth');
const { encrypt, decrypt } = require('../crypto');

const FORMAT = 'sgops-backup';
const VERSION = 1;
const SCRYPT_PARAMS = { N: 16384, r: 8, p: 1 };

/** 数组型配置集合（按 id 合并 / 整体替换） */
const ARRAY_COLLECTIONS = ['hosts', 'scripts', 'rules', 'accounts', 'dbSources', 'schedules', 'sqlScripts', 'etlTasks', 'dockerHosts', 'kubeClusters'];
/** 对象型配置集合 */
const OBJECT_COLLECTIONS = ['aiConfig', 'aiAgent', 'modulePermissions'];
/** 执行历史（默认不导出，勾选后一并备份） */
const HISTORY_COLLECTIONS = ['tasks', 'sqlHistory', 'etlRuns', 'alerts'];
/** 集合内的可逆加密字段：导出时解明、导入时重新加密 */
const SECRET_FIELDS = {
    hosts: ['password'],
    accounts: ['password'],
    dbSources: ['password'],
    dockerHosts: ['token'],
    aiConfig: ['apiKey']
};

const operator = () => (auth.getSession() || {}).username || (store.get('config') || {}).currentUser || '-';

function deriveKey(passphrase, salt) {
    return crypto.scryptSync(String(passphrase), salt, 32, SCRYPT_PARAMS);
}

function seal(snapshots, passphrase) {
    const salt = crypto.randomBytes(16);
    const iv = crypto.randomBytes(12);
    const key = deriveKey(passphrase, salt);
    const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
    const plain = Buffer.from(JSON.stringify(snapshots), 'utf8');
    const data = Buffer.concat([cipher.update(plain), cipher.final()]);
    return JSON.stringify({
        format: FORMAT,
        version: VERSION,
        createdAt: store.nowText(),
        app: 'SgOps',
        kdf: { algo: 'scrypt', ...SCRYPT_PARAMS, salt: salt.toString('base64') },
        cipher: { algo: 'aes-256-gcm', iv: iv.toString('base64'), tag: cipher.getAuthTag().toString('base64') },
        payload: data.toString('base64')
    }, null, 2);
}

function unseal(envelopeText, passphrase) {
    let env;
    try {
        env = JSON.parse(envelopeText);
    } catch (e) {
        return { ok: false, message: '文件不是有效的备份信封（JSON 解析失败）' };
    }
    if (!env || env.format !== FORMAT) return { ok: false, message: '不是 SgOps 备份文件（format 字段缺失）' };
    if (!env.kdf || !env.cipher || !env.payload) return { ok: false, message: '备份文件结构不完整' };
    try {
        const salt = Buffer.from(env.kdf.salt, 'base64');
        const iv = Buffer.from(env.cipher.iv, 'base64');
        const tag = Buffer.from(env.cipher.tag, 'base64');
        const key = crypto.scryptSync(String(passphrase), salt, 32, {
            N: Number(env.kdf.N) || SCRYPT_PARAMS.N,
            r: Number(env.kdf.r) || SCRYPT_PARAMS.r,
            p: Number(env.kdf.p) || SCRYPT_PARAMS.p
        });
        const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
        decipher.setAuthTag(tag);
        const plain = Buffer.concat([decipher.update(Buffer.from(env.payload, 'base64')), decipher.final()]);
        return { ok: true, data: JSON.parse(plain.toString('utf8')), meta: { createdAt: env.createdAt } };
    } catch (e) {
        return { ok: false, message: '解密失败：备份口令错误或文件已被篡改' };
    }
}

/** 取某集合的导出快照（凭据解明） */
function snapshotCollection(key) {
    const fields = SECRET_FIELDS[key];
    const raw = key === 'config'
        ? (() => { const { currentUser, ...rest } = store.get('config') || {}; return rest; })()
        : store.get(key) !== undefined && !Array.isArray(store.get(key))
            ? store.get(key)
            : store.list(key);
    if (Array.isArray(raw)) {
        return raw.map(item => {
            if (!fields) return item;
            const copy = { ...item };
            fields.forEach(f => { if (copy[f]) copy[f] = decrypt(copy[f]); });
            return copy;
        });
    }
    if (raw && typeof raw === 'object' && fields) {
        const copy = { ...raw };
        fields.forEach(f => { if (copy[f]) copy[f] = decrypt(copy[f]); });
        return copy;
    }
    return raw;
}

/** 将导入内容写回当前库：数组集合按 merge/replace，对象集合整体替换 */
function applySnapshot(snapshots, mode) {
    const db = store.load();
    const counts = {};
    const currentUsername = operator();

    ARRAY_COLLECTIONS.concat(HISTORY_COLLECTIONS).concat(['users']).forEach(key => {
        if (!Array.isArray(snapshots[key])) return;
        if (mode === 'replace') {
            const incoming = snapshots[key];
            if (key === 'users' && !incoming.some(u => u.username === currentUsername)) {
                const self = (db.users || []).find(u => u.username === currentUsername);
                if (self) incoming.push(self); // 保底：不允许把自己替换没了
            }
            db[key] = incoming;
            counts[key] = incoming.length;
        } else {
            const arr = db[key] || (db[key] = []);
            let touched = 0;
            snapshots[key].forEach(item => {
                const idx = item.id ? arr.findIndex(x => x.id === item.id) : -1;
                if (idx >= 0) arr[idx] = { ...arr[idx], ...item };
                else arr.unshift(item);
                touched++;
            });
            counts[key] = touched;
        }
    });

    OBJECT_COLLECTIONS.forEach(key => {
        if (!snapshots[key] || typeof snapshots[key] !== 'object') return;
        db[key] = snapshots[key];
        counts[key] = 1;
    });

    if (snapshots.config && typeof snapshots.config === 'object') {
        db.config = { ...(db.config || {}), ...snapshots.config };
        counts.config = 1;
    }

    // 导入的凭据字段用本机密钥重新加密（支持跨机恢复）
    Object.keys(SECRET_FIELDS).forEach(key => {
        const fields = SECRET_FIELDS[key];
        (Array.isArray(db[key]) ? db[key] : []).forEach(item => {
            fields.forEach(f => {
                if (typeof item[f] === 'string' && item[f] && !item[f].startsWith('v1:')) item[f] = encrypt(item[f]);
            });
        });
        if (db.aiConfig && key === 'aiConfig' && typeof db.aiConfig.apiKey === 'string' && db.aiConfig.apiKey && !db.aiConfig.apiKey.startsWith('v1:')) {
            db.aiConfig.apiKey = encrypt(db.aiConfig.apiKey);
        }
    });

    store.persist();
    return counts;
}

function setup(ipcMain) {
    ipcMain.handle('system:backup:export', async (e, payload = {}) => {
        const passphrase = String(payload.passphrase || '');
        if (passphrase.length < 8) return { ok: false, message: '备份口令至少 8 位' };

        const wins = e.sender ? [require('electron').BrowserWindow.fromWebContents(e.sender)] : [];
        const { canceled, filePath } = await dialog.showSaveDialog(wins[0] || undefined, {
            title: '导出配置备份',
            defaultPath: `SgOps-backup-${new Date().toISOString().slice(0, 16).replace(/[-:T]/g, '')}.json`,
            filters: [{ name: 'SgOps 备份（加密）', extensions: ['json'] }]
        });
        if (canceled || !filePath) return { ok: false, canceled: true };

        const snapshots = {};
        const counts = {};
        ARRAY_COLLECTIONS.forEach(key => { snapshots[key] = snapshotCollection(key); counts[key] = snapshots[key].length; });
        OBJECT_COLLECTIONS.forEach(key => { snapshots[key] = snapshotCollection(key); });
        snapshots.config = snapshotCollection('config');
        if (payload.includeUsers !== false) {
            // 登录口令为 scrypt 单向哈希，可直接跨机恢复
            snapshots.users = store.list('users');
            counts.users = snapshots.users.length;
        }
        if (payload.includeHistory) {
            HISTORY_COLLECTIONS.forEach(key => { snapshots[key] = snapshotCollection(key); counts[key] = snapshots[key].length; });
        }

        try {
            fs.writeFileSync(filePath, seal(snapshots, passphrase), 'utf8');
        } catch (err) {
            return { ok: false, message: '写入备份文件失败：' + err.message };
        }

        audit.write({
            type: '操作', user: operator(),
            detail: `导出配置备份至 ${filePath}（集合 ${Object.keys(snapshots).length} 个${payload.includeHistory ? ' · 含执行历史' : ''}${payload.includeUsers === false ? ' · 不含用户' : ''}）`
        });
        return { ok: true, filePath, counts };
    });

    ipcMain.handle('system:backup:import', async (e, payload = {}) => {
        const passphrase = String(payload.passphrase || '');
        if (!passphrase) return { ok: false, message: '请输入备份口令' };
        const mode = payload.mode === 'replace' ? 'replace' : 'merge';

        const wins = e.sender ? [require('electron').BrowserWindow.fromWebContents(e.sender)] : [];
        const { canceled, filePaths } = await dialog.showOpenDialog(wins[0] || undefined, {
            title: '选择备份文件',
            properties: ['openFile'],
            filters: [{ name: 'SgOps 备份（加密）', extensions: ['json'] }]
        });
        if (canceled || !filePaths.length) return { ok: false, canceled: true };

        let text = '';
        try {
            text = fs.readFileSync(filePaths[0], 'utf8');
        } catch (err) {
            return { ok: false, message: '读取备份文件失败：' + err.message };
        }
        const unsealed = unseal(text, passphrase);
        if (!unsealed.ok) return unsealed;

        // 先备份当前库文件，导入出问题时手工可回退
        try {
            fs.copyFileSync(store.DB_FILE, store.DB_FILE + '.pre-import-' + Date.now());
        } catch (err) { /* 首次运行无库文件时忽略 */ }

        const counts = applySnapshot(unsealed.data, mode);
        audit.write({
            type: '操作', user: operator(),
            detail: `导入配置备份（${filePathPathsLabel(filePaths[0])} · 模式：${mode === 'replace' ? '替换' : '合并'} · 共 ${Object.values(counts).reduce((a, b) => a + b, 0)} 条）`
        });
        return { ok: true, filePath: filePaths[0], createdAt: unsealed.meta.createdAt, counts, mode };
    });
}

function filePathPathsLabel(p) {
    return String(p || '').split(/[\\/]/).pop() || '-';
}

module.exports = { setup };
