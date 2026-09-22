/**
 * 外置密钥配置（配置外挂）
 * ------------------------------------------------------------------
 * 启动后按需加载一个 gitignore 的外置 JSON 文件，用于注入 AI apiKey、
 * 各实体口令等敏感数据——这些值不再必须写死在应用存储里。
 *
 * 查找顺序（先命中先用）：
 *   1. 环境变量 SGOPS_SECRETS_FILE 指定的路径
 *   2. <exe 所在目录>/sgops.secrets.json     （便携外挂，随程序目录迁移）
 *   3. <userData>/data/sgops.secrets.json    （默认位置）
 *
 * 文件格式：
 *   {
 *     "ai": { "apiKey": "sk-...", "baseURL": "...", "model": "...", "provider": "..." },
 *     "secrets": {
 *       "db:d_01": "口令",              // 数据库源 d_01 的 password
 *       "host:h_04": "口令",            // 主机的 password；":passphrase" 后缀为私钥口令
 *       "docker:dh_01": "…",            // Docker 端点 token
 *       "ledger:ld_x": "…", "acc:a_01": "…"
 *     }
 *   }
 * 值可为明文，也可为本机密钥加密的 "v1:..." 密文（用界面「加密工具」生成），
 * 避免外置文件本身以明文落盘。文件修改后按 mtime 自动重载，无需重启。
 */
const fs = require('fs');
const path = require('path');
const { app } = require('electron');
const store = require('./store');
const { encrypt, decrypt } = require('./crypto');

let cache = { file: null, mtimeMs: -1, data: null };

/** 解析外置文件路径（按优先级返回首个存在者；都不存在返回默认写入位置） */
function resolveFilePath() {
    const env = String(process.env.SGOPS_SECRETS_FILE || '').trim();
    if (env) return env;
    const nextToExe = path.join(path.dirname(process.execPath), 'sgops.secrets.json');
    if (fs.existsSync(nextToExe)) return nextToExe;
    return path.join(app.getPath('userData'), 'data', 'sgops.secrets.json');
}

function load() {
    const file = resolveFilePath();
    let mtimeMs = -1;
    try {
        mtimeMs = fs.statSync(file).mtimeMs;
    } catch (e) { /* 不存在 */ }
    if (cache.file === file && cache.mtimeMs === mtimeMs && cache.data) return cache.data;
    let data = {};
    if (mtimeMs >= 0) {
        try {
            data = JSON.parse(fs.readFileSync(file, 'utf8')) || {};
        } catch (e) {
            data = { __error: '外置密钥文件解析失败：' + e.message };
        }
    }
    cache = { file, mtimeMs, data };
    return data;
}

/** 取一个值：v1: 密文用本机密钥解密，明文原样返回 */
function value(raw) {
    if (typeof raw !== 'string' || !raw) return '';
    return raw.startsWith('v1:') ? decrypt(raw) : raw;
}

/**
 * 统一取值入口：外置文件优先，未命中时回落应用存储的密文。
 * @param {string} key 形如 db:d_01 / host:h_04 / ledger:ld_1
 * @param {string} storedCipher 应用存储里的加密字段（可为空）
 */
function resolve(key, storedCipher) {
    const data = load();
    const ext = (data.secrets || {})[key];
    if (ext !== undefined && ext !== null && String(ext) !== '') return value(String(ext));
    return decrypt(storedCipher);
}

/** 外置 AI 配置段（仅返回非空字段，供 getAIConfig 覆盖） */
function aiOverride() {
    const ai = load().ai || {};
    const out = {};
    ['apiKey', 'baseURL', 'model', 'provider'].forEach(k => {
        if (ai[k] && String(ai[k]).trim()) out[k] = String(ai[k]).trim();
    });
    if (out.apiKey) out.apiKey = value(out.apiKey);
    return out;
}

/** 界面状态：文件位置、是否存在、已注入哪些键（不回显任何明文值） */
function status() {
    const data = load();
    const exists = cache.mtimeMs >= 0;
    return {
        ok: true,
        file: cache.file,
        exists,
        error: data.__error || null,
        autoSync: syncEnabled(),
        aiKeys: Object.keys(data.ai || {}).filter(k => data.ai[k]),
        secretKeys: Object.keys(data.secrets || {}),
        count: Object.keys(data.secrets || {}).length
    };
}

const TEMPLATE = {
    _说明: 'SgOps 外置密钥文件。值可为明文，或界面「加密工具」生成的 v1: 密文（仅本机可解）。改完自动生效，无需重启。',
    ai: { apiKey: '', baseURL: '', model: '', provider: '' },
    secrets: {
        'db:d_01': '',
        'host:h_04': '',
        'ledger:台账条目ID': ''
    }
};

/** 生成模板文件（已存在则不覆盖） */
function writeTemplate() {
    const file = resolveFilePath();
    if (fs.existsSync(file)) return { ok: true, created: false, file, message: '文件已存在，未覆盖' };
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(TEMPLATE, null, 2), 'utf8');
    cache = { file: null, mtimeMs: -1, data: null };
    return { ok: true, created: true, file };
}

/** 加密工具：明文 → v1: 密文（供用户粘贴进外置文件避免明文） */
function encryptValue(plain) {
    if (!String(plain || '')) return { ok: false, message: '请输入要加密的内容' };
    return { ok: true, cipher: encrypt(String(plain)) };
}

/* ---------------- 自动同步（应用 → 外置文件） ---------------- */

/** 同步开关：config.secretsAutoSync，默认开启 */
function syncEnabled() {
    try {
        return (store.load().config || {}).secretsAutoSync !== false;
    } catch (e) {
        return false;
    }
}

/** 读-改-写外置文件（v1: 密文落盘，原子替换）；明文为空时等同删除键 */
function mutate(fn) {
    if (!syncEnabled()) return { ok: true, skipped: true };
    const file = resolveFilePath();
    let data = {};
    try {
        data = JSON.parse(fs.readFileSync(file, 'utf8')) || {};
    } catch (e) { /* 不存在或损坏则重建（损坏时旧内容作废） */ }
    fn(data);
    try {
        fs.mkdirSync(path.dirname(file), { recursive: true });
        const tmp = file + '.tmp';
        fs.writeFileSync(tmp, JSON.stringify(data, null, 2), 'utf8');
        fs.renameSync(tmp, file);
        cache = { file: null, mtimeMs: -1, data: null };   // 强制下次重读
        return { ok: true, file };
    } catch (e) {
        return { ok: false, message: '外置密钥文件写入失败：' + e.message };
    }
}

/** 实体口令保存后同步进外置文件（键如 db:d_01）；空值=移除该键 */
function syncSet(key, plain) {
    return mutate(data => {
        data.secrets = data.secrets || {};
        if (plain === undefined || plain === null || String(plain) === '') delete data.secrets[key];
        else data.secrets[key] = encrypt(String(plain));
    });
}

/** 实体删除时移除对应键（含 :passphrase 后缀键） */
function syncRemove(key) {
    return mutate(data => {
        data.secrets = data.secrets || {};
        delete data.secrets[key];
        delete data.secrets[key + ':passphrase'];
    });
}

/** AI apiKey 保存后同步到 ai 段 */
function syncSetAi(plain) {
    return mutate(data => {
        data.ai = data.ai || {};
        if (plain === undefined || plain === null || String(plain) === '') delete data.ai.apiKey;
        else data.ai.apiKey = encrypt(String(plain));
    });
}

module.exports = { resolve, aiOverride, status, writeTemplate, encryptValue, resolveFilePath, syncSet, syncRemove, syncSetAi, syncEnabled };
