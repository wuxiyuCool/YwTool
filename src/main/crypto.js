/**
 * 本地加密工具 · AES-256-GCM
 * 密钥首次运行时随机生成，保存于用户数据目录（不上传、不入库）
 */
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { app } = require('electron');

const ALGO = 'aes-256-gcm';
let cachedKey = null;

function keyFilePath() {
    return path.join(app.getPath('userData'), 'data', '.secret.key');
}

function getKey() {
    if (cachedKey) return cachedKey;
    const file = keyFilePath();
    if (fs.existsSync(file)) {
        cachedKey = Buffer.from(fs.readFileSync(file, 'utf8').trim(), 'hex');
    } else {
        cachedKey = crypto.randomBytes(32);
        fs.mkdirSync(path.dirname(file), { recursive: true });
        fs.writeFileSync(file, cachedKey.toString('hex'), { mode: 0o600 });
    }
    return cachedKey;
}

/** 加密：返回 v1:iv:tag:cipher 格式，空值返回空串 */
function encrypt(plain) {
    if (plain === undefined || plain === null || plain === '') return '';
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv(ALGO, getKey(), iv);
    const data = Buffer.concat([cipher.update(String(plain), 'utf8'), cipher.final()]);
    return ['v1', iv.toString('base64'), cipher.getAuthTag().toString('base64'), data.toString('base64')].join(':');
}

/** 解密：失败返回空串（不抛异常，避免脏数据中断流程） */
function decrypt(payload) {
    if (!payload || typeof payload !== 'string') return '';
    const parts = payload.split(':');
    if (parts.length !== 4 || parts[0] !== 'v1') return '';
    try {
        const iv = Buffer.from(parts[1], 'base64');
        const tag = Buffer.from(parts[2], 'base64');
        const data = Buffer.from(parts[3], 'base64');
        const decipher = crypto.createDecipheriv(ALGO, getKey(), iv);
        decipher.setAuthTag(tag);
        return Buffer.concat([decipher.update(data), decipher.final()]).toString('utf8');
    } catch (e) {
        return '';
    }
}

/** 统一脱敏显示 */
const MASK = '●●●●●●●●';

/* ---------------- 用户口令哈希（scrypt，单向不可逆） ---------------- */

const SCRYPT_PARAMS = { N: 16384, r: 8, p: 1 };
const SCRYPT_VERSION = 's1';

function hashPassword(plain) {
    const salt = crypto.randomBytes(16);
    const hash = crypto.scryptSync(String(plain), salt, 32, SCRYPT_PARAMS);
    return `${SCRYPT_VERSION}:${salt.toString('base64')}:${hash.toString('base64')}`;
}

function verifyPassword(plain, stored) {
    if (!stored || typeof stored !== 'string') return false;
    const parts = stored.split(':');
    if (parts.length !== 3 || parts[0] !== SCRYPT_VERSION) return false;
    try {
        const salt = Buffer.from(parts[1], 'base64');
        const expected = Buffer.from(parts[2], 'base64');
        const actual = crypto.scryptSync(String(plain), salt, expected.length, SCRYPT_PARAMS);
        return crypto.timingSafeEqual(actual, expected);
    } catch (e) {
        return false;
    }
}

module.exports = { encrypt, decrypt, mask: () => MASK, hashPassword, verifyPassword };
