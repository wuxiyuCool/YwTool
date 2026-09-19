/**
 * 信息安全工具箱（主进程）
 * ------------------------------------------------------------------
 * 参考 hiencode.com 的工具集，全部在本机计算，不出网：
 *   - 哈希摘要：MD5 / SHA-1 / SHA-256 / SHA-512
 *   - 对称加解密：AES-128/192/256 × CBC/ECB/CTR/GCM、DES-EDE3(CBC)、RC4（依赖 OpenSSL 可用性）
 *   - JWT：头部/载荷解码 + HS256/384/512 签名校验
 *   - 二维码：生成（qrcode）与识别（jimp + jsQR），懒加载，缺依赖时给出明确提示
 * Base64/Hex/URL/Unicode 等纯文本转换在渲染进程本地完成，不占用 IPC。
 */
const crypto = require('crypto');
const zlib = require('zlib');

/* ---------------- 哈希 ---------------- */

const HASHES = ['md5', 'sha1', 'sha256', 'sha512'];

function hash(payload = {}) {
    const input = String(payload.text ?? '');
    const enc = payload.inputEncoding === 'hex' ? 'hex'
        : payload.inputEncoding === 'base64' ? 'base64' : 'utf8';
    const buf = Buffer.from(input, enc);
    const out = {};
    HASHES.forEach(algo => {
        out[algo] = crypto.createHash(algo).update(buf).digest(payload.outEncoding || 'hex');
    });
    return { ok: true, hashes: out };
}

/* ---------------- 对称加解密 ---------------- */

/** 算法清单：keyLen 单位字节（0 表示流密码不强制），iv 表示需要 IV 的字节数 */
const CIPHERS = {
    'AES-128-CBC': { node: 'aes-128-cbc', keyLen: 16, iv: 16 },
    'AES-192-CBC': { node: 'aes-192-cbc', keyLen: 24, iv: 16 },
    'AES-256-CBC': { node: 'aes-256-cbc', keyLen: 32, iv: 16 },
    'AES-128-ECB': { node: 'aes-128-ecb', keyLen: 16, iv: 0 },
    'AES-192-ECB': { node: 'aes-192-ecb', keyLen: 24, iv: 0 },
    'AES-256-ECB': { node: 'aes-256-ecb', keyLen: 32, iv: 0 },
    'AES-128-CTR': { node: 'aes-128-ctr', keyLen: 16, iv: 16 },
    'AES-256-CTR': { node: 'aes-256-ctr', keyLen: 32, iv: 16 },
    'AES-128-CFB': { node: 'aes-128-cfb', keyLen: 16, iv: 16 },
    'AES-256-CFB': { node: 'aes-256-cfb', keyLen: 32, iv: 16 },
    'AES-128-OFB': { node: 'aes-128-ofb', keyLen: 16, iv: 16 },
    'AES-256-OFB': { node: 'aes-256-ofb', keyLen: 32, iv: 16 },
    'AES-256-GCM': { node: 'aes-256-gcm', keyLen: 32, iv: 12, aead: true },
    'DES-CBC': { node: 'des-cbc', keyLen: 8, iv: 8 },
    '3DES-CBC': { node: 'des-ede3-cbc', keyLen: 24, iv: 8 },
    RC4: { node: 'rc4', keyLen: 0, iv: 0, stream: true }
};

/** 口令 → 密钥：utf8 补齐/截断到算法所需长度（工具用途，与生产 KDF 区分） */
function normalizeKey(text, byteLen) {
    const buf = Buffer.from(String(text || ''), 'utf8');
    if (byteLen === 0) return buf.length ? buf : Buffer.alloc(1);
    if (buf.length === byteLen) return buf;
    if (buf.length > byteLen) return buf.subarray(0, byteLen);
    const out = Buffer.alloc(byteLen);
    for (let i = 0; i < byteLen; i++) out[i] = buf.length ? buf[i % buf.length] : 0x20;
    return out;
}

function parseIv(text, byteLen, encoding) {
    if (!byteLen) return null;
    const raw = String(text || '');
    if (!raw) throw new Error('该模式需要 IV（' + byteLen + ' 字节）');
    const buf = Buffer.from(raw, encoding === 'hex' ? 'hex' : encoding === 'base64' ? 'base64' : 'utf8');
    if (buf.length < byteLen) {
        const out = Buffer.alloc(byteLen);
        buf.copy(out);
        return out;
    }
    return buf.subarray(0, byteLen);
}

function cipher(payload = {}) {
    const def = CIPHERS[payload.algorithm];
    if (!def) return { ok: false, message: '不支持的算法：' + payload.algorithm };
    const mode = payload.mode === 'decrypt' ? 'decrypt' : 'encrypt';
    const dataEnc = payload.dataEncoding === 'hex' ? 'hex' : payload.dataEncoding === 'base64' ? 'base64' : 'utf8';
    const outEnc = payload.outEncoding === 'hex' ? 'hex' : 'base64';
    try {
        const key = normalizeKey(payload.key, def.keyLen);
        const iv = parseIv(payload.iv, def.iv, payload.ivEncoding);
        const data = Buffer.from(String(payload.data ?? ''), dataEnc);
        if (def.aead) {
            if (mode === 'encrypt') {
                const c = crypto.createCipheriv(def.node, key, iv);
                const enc = Buffer.concat([c.update(data), c.final(), c.getAuthTag()]);
                return { ok: true, result: enc.toString(outEnc), note: '输出末尾附加 16 字节 GCM AuthTag' };
            }
            if (data.length <= 16) throw new Error('GCM 密文长度不足（应包含 16 字节 AuthTag）');
            const d = crypto.createDecipheriv(def.node, key, iv);
            d.setAuthTag(data.subarray(data.length - 16));
            const dec = Buffer.concat([d.update(data.subarray(0, data.length - 16)), d.final()]);
            return { ok: true, result: dec.toString('utf8') };
        }
        if (mode === 'encrypt') {
            const c = def.stream ? crypto.createCipheriv(def.node, key, null) : crypto.createCipheriv(def.node, key, iv);
            return { ok: true, result: Buffer.concat([c.update(data), c.final()]).toString(outEnc) };
        }
        const d = def.stream ? crypto.createDecipheriv(def.node, key, null) : crypto.createDecipheriv(def.node, key, iv);
        return { ok: true, result: Buffer.concat([d.update(data), d.final()]).toString('utf8') };
    } catch (err) {
        const hint = /unsupported|no such|invalid algorithm|cipher with key length/i.test(err.message)
            ? '（OpenSSL 3 已禁用该算法，如 RC4/单 DES 需要 legacy provider，属环境限制而非代码问题）' : '';
        return { ok: false, message: err.message + hint };
    }
}

const cipherList = () => Object.keys(CIPHERS);

/* ---------------- JWT ---------------- */

const b64url = s => Buffer.from(s, 'base64').toString('utf8');

function jwt(payload = {}) {
    const token = String(payload.token || '').trim();
    const parts = token.split('.');
    if (parts.length !== 3) return { ok: false, message: 'JWT 应为 header.payload.signature 三段结构' };
    let header; let body;
    try {
        header = JSON.parse(b64url(parts[0]));
        body = JSON.parse(b64url(parts[1]));
    } catch (e) {
        return { ok: false, message: 'header/payload 不是合法 JSON（base64url 解码失败）' };
    }
    const out = { ok: true, header, payload: body, signatureB64url: parts[2] };
    if (payload.secret) {
        const algo = (header.alg || '').toUpperCase();
        const map = { HS256: 'sha256', HS384: 'sha384', HS512: 'sha512' };
        if (!map[algo]) {
            out.verifyNote = `暂只支持 HS* 系列验签（当前 alg=${algo}）`;
        } else {
            const expect = crypto.createHmac(map[algo], String(payload.secret))
                .update(parts[0] + '.' + parts[1]).digest('base64url');
            out.valid = expect.length === parts[2].length
                && crypto.timingSafeEqual(Buffer.from(expect), Buffer.from(parts[2]));
        }
    }
    return out;
}

/* ---------------- HMAC / PBKDF2 ---------------- */

function hmac(payload = {}) {
    const algo = String(payload.algo || 'sha256').toLowerCase();
    if (!['md5', 'sha1', 'sha256', 'sha512'].includes(algo)) return { ok: false, message: '不支持的摘要算法' };
    try {
        const dataEnc = payload.dataEncoding === 'hex' ? 'hex' : payload.dataEncoding === 'base64' ? 'base64' : 'utf8';
        const h = crypto.createHmac(algo, Buffer.from(String(payload.key ?? ''), dataEnc))
            .update(Buffer.from(String(payload.text ?? ''), dataEnc));
        return { ok: true, result: h.digest(payload.outEncoding === 'base64' ? 'base64' : 'hex') };
    } catch (err) {
        return { ok: false, message: err.message };
    }
}

function pbkdf2(payload = {}) {
    try {
        const iterations = Math.min(Math.max(Number(payload.iterations) || 100000, 1), 2000000);
        const keyLen = Math.min(Math.max(Number(payload.keyLen) || 32, 4), 512);
        const digest = ['sha1', 'sha256', 'sha512'].includes(payload.digest) ? payload.digest : 'sha256';
        const out = crypto.pbkdf2Sync(
            Buffer.from(String(payload.password ?? ''), 'utf8'),
            Buffer.from(String(payload.salt ?? ''), 'utf8'),
            iterations, keyLen, digest
        );
        return { ok: true, result: out.toString(payload.outEncoding === 'base64' ? 'base64' : 'hex'), iterations, keyLen, digest };
    } catch (err) {
        return { ok: false, message: err.message };
    }
}

/* ---------------- 压缩编码（gzip / deflate / brotli ↔ Base64/Hex） ---------------- */

function codec(payload = {}) {
    try {
        const data = Buffer.from(String(payload.data ?? ''), payload.dataEncoding === 'hex' ? 'hex' : payload.dataEncoding === 'base64' ? 'base64' : 'utf8');
        const outEnc = payload.outEncoding === 'hex' ? 'hex' : 'base64';
        const map = {
            gzip: d => zlib.gzipSync(d),
            gunzip: d => zlib.gunzipSync(d),
            deflate: d => zlib.deflateSync(d),
            inflate: d => zlib.inflateSync(d),
            brotli: d => zlib.brotliCompressSync(d),
            unbrotli: d => zlib.brotliDecompressSync(d)
        };
        const fn = map[String(payload.mode || '')];
        if (!fn) return { ok: false, message: '不支持的压缩模式' };
        const out = fn(data);
        const isText = ['gunzip', 'inflate', 'unbrotli'].includes(payload.mode);
        return { ok: true, result: out.toString(isText ? 'utf8' : outEnc), bytes: out.length };
    } catch (err) {
        return { ok: false, message: err.message + '（解压模式请选择 Base64/Hex 输入）' };
    }
}

/* ---------------- RSA（密钥对 / OAEP 加解密 / SHA-256 签名验签） ---------------- */

function readKey(pem, type) {
    const opts = { key: String(pem || ''), format: 'pem' };
    return type === 'private' ? crypto.createPrivateKey(opts) : crypto.createPublicKey(opts);
}

function rsa(payload = {}) {
    try {
        switch (payload.action) {
            case 'generate': {
                const { publicKey, privateKey } = crypto.generateKeyPairSync('rsa', {
                    modulusLength: Math.min(Math.max(Number(payload.modulusLength) || 2048, 2048), 4096)
                });
                return {
                    ok: true,
                    publicKey: publicKey.export({ type: 'pkcs1', format: 'pem' }).toString(),
                    privateKey: privateKey.export({ type: 'pkcs1', format: 'pem' }).toString()
                };
            }
            case 'encrypt': {
                const enc = crypto.publicEncrypt(
                    { key: readKey(payload.publicKey, 'public'), padding: crypto.constants.RSA_PKCS1_OAEP_PADDING, oaepHash: 'sha256' },
                    Buffer.from(String(payload.text ?? ''), 'utf8')
                );
                return { ok: true, result: enc.toString('base64') };
            }
            case 'decrypt': {
                const dec = crypto.privateDecrypt(
                    { key: readKey(payload.privateKey, 'private'), padding: crypto.constants.RSA_PKCS1_OAEP_PADDING, oaepHash: 'sha256' },
                    Buffer.from(String(payload.text || '').trim(), 'base64')
                );
                return { ok: true, result: dec.toString('utf8') };
            }
            case 'sign': {
                const sig = crypto.createSign('RSA-SHA256').update(String(payload.text ?? ''), 'utf8')
                    .sign(readKey(payload.privateKey, 'private'));
                return { ok: true, result: sig.toString('base64') };
            }
            case 'verify': {
                const valid = crypto.createVerify('RSA-SHA256').update(String(payload.text ?? ''), 'utf8')
                    .verify(readKey(payload.publicKey, 'public'), Buffer.from(String(payload.signature || '').trim(), 'base64'));
                return { ok: true, valid };
            }
            default:
                return { ok: false, message: '不支持的 RSA 动作' };
        }
    } catch (err) {
        return { ok: false, message: err.message };
    }
}

/* ---------------- 二维码（懒加载可选依赖） ---------------- */

let qrLib; let jimpLib; let jsqrLib;
const qrDeps = { generate: undefined, decode: undefined };

async function lazyQr() {
    if (qrLib !== undefined) return qrLib;
    try { qrLib = require('qrcode'); } catch (e) { qrLib = null; }
    return qrLib;
}

async function lazyDecodeDeps() {
    if (jsqrLib !== undefined && jimpLib !== undefined) return { jimp: jimpLib, jsqr: jsqrLib };
    try {
        // jimp 1.x 为 ESM 优先，动态 import 兜底
        jimpLib = require('jimp');
        if (!jimpLib || !(jimpLib.Jimp || jimpLib.read)) jimpLib = await import('jimp');
    } catch (e) { jimpLib = null; }
    try { jsqrLib = require('jsqr'); } catch (e) { jsqrLib = null; }
    return { jimp: jimpLib, jsqr: jsqrLib };
}

async function qrGenerate(payload = {}) {
    const lib = await lazyQr();
    if (!lib) return { ok: false, message: '缺少依赖 qrcode：npm install qrcode' };
    try {
        const dataUrl = await lib.toDataURL(String(payload.text || ''), {
            width: Number(payload.size) || 260,
            margin: 1
        });
        return { ok: true, dataUrl };
    } catch (err) {
        return { ok: false, message: '生成失败：' + err.message };
    }
}

async function qrDecode(payload = {}) {
    const { jimp, jsqr } = await lazyDecodeDeps();
    const jsQr = jsqr && (jsqr.default || jsqr);
    if (!jimp || !jsQr) {
        return { ok: false, message: '缺少依赖：npm install jimp jsqr（识别需要 jimp 解码图片像素）' };
    }
    try {
        const dataUrl = String(payload.image || '');
        const base64 = dataUrl.includes(',') ? dataUrl.split(',').pop() : dataUrl;
        const buf = Buffer.from(base64, 'base64');
        const JimpCtor = jimp.Jimp || jimp.default || jimp;
        let image;
        if (typeof JimpCtor.read === 'function') image = await JimpCtor.read(buf);
        else if (typeof JimpCtor === 'function') image = await new Promise((res, rej) => JimpCtor.read ? res() : (new JimpCtor(buf, (e, i) => e ? rej(e) : res(i))));
        else image = await JimpCtor(buf);
        const { width, height } = image.bitmap || image;
        const rgba = image.bitmap ? image.bitmap.data : image.data;
        // jimp 的 bitmap.data 是 RGBA Buffer，jsQR 要 Uint8ClampedArray(RGBA)
        const pixels = new Uint8ClampedArray(rgba.buffer, rgba.byteOffset, rgba.byteLength);
        const result = jsQr(pixels, width, height);
        return result && result.data
            ? { ok: true, text: result.data }
            : { ok: false, message: '未在图片中识别到二维码' };
    } catch (err) {
        return { ok: false, message: '识别失败：' + err.message };
    }
}

const driverStatus = async () => {
    const deps = await lazyDecodeDeps();
    return {
        qrcode: !!(await lazyQr()),
        jimp: !!deps.jimp,
        jsqr: !!(deps.jsqr)
    };
};

module.exports = { hash, cipher, cipherList, hmac, pbkdf2, codec, rsa, jwt, qrGenerate, qrDecode, driverStatus };
