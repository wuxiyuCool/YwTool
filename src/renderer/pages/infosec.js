/**
 * 安全运维 · 信息安全工具箱（参考 hiencode.com 工具集）
 * 分组：
 *   哈希摘要    —— MD5 / SHA-1 / SHA-256 / SHA-512（主进程 crypto 计算）
 *   编码转换    —— Base64 / URL / Hex / Unicode / HTML 实体（渲染进程本地完成，不出 IPC）
 *   对称加解密  —— AES 系列 / 3DES / RC4（主进程）
 *   JWT         —— 三段解码 + HS* 验签（主进程）
 *   随机生成    —— 强随机密码 / UUID / 随机 HEX
 *   二维码      —— 生成（qrcode）与识别（jimp + jsQR），依赖缺失时给出安装提示
 */
import { api, demoMode } from '../api.js';
import { esc, toast, demoBanner, guardAdmin } from '../ui.js';

let root = null;

const copyBtn = '<button class="btn btn-ghost btn-sm sec-copy" title="复制到剪贴板">复制</button>';
const outBox = (id, mono = true) => `<div class="sec-out ${mono ? 'mono' : ''}" id="${id}">—</div>`;

function b64Encode(s) { return btoa(unescape(encodeURIComponent(s))); }
function b64Decode(s) { return decodeURIComponent(escape(atob(s.trim()))); }

export function render() {
    return `
    ${demoBanner(demoMode)}
    <div class="grid-2 sec-grid">

        <div class="card">
            <div class="card-header"><div><div class="card-title">哈希摘要</div>
                <div class="card-desc">MD5 / SHA-1 / SHA-256 / SHA-512，支持文本或 Base64/Hex 输入</div></div></div>
            <div class="form-item">
                <textarea class="textarea code-input" id="sh-text" rows="4" placeholder="输入待计算内容..."></textarea>
            </div>
            <div class="toolbar">
                <label class="muted" style="font-size:12.5px">输入编码</label>
                <select class="select" id="sh-enc" style="width:110px"><option value="utf8">UTF-8 文本</option><option value="base64">Base64</option><option value="hex">Hex</option></select>
                <div class="spacer"></div>
                <button class="btn btn-primary btn-sm" id="sh-run">计算摘要</button>
            </div>
            <div class="table-wrap"><table class="table" id="sh-table" style="display:none">
                <tbody>
                    <tr><td style="width:90px">MD5</td><td class="mono" data-h="md5"></td><td style="width:60px">${copyBtn}</td></tr>
                    <tr><td>SHA-1</td><td class="mono" data-h="sha1"></td><td>${copyBtn}</td></tr>
                    <tr><td>SHA-256</td><td class="mono" data-h="sha256"></td><td>${copyBtn}</td></tr>
                    <tr><td>SHA-512</td><td class="mono" data-h="sha512"></td><td>${copyBtn}</td></tr>
                </tbody>
            </table></div>
        </div>

        <div class="card">
            <div class="card-header"><div><div class="card-title">编码转换</div>
                <div class="card-desc">本地即时转换，不经过任何服务</div></div></div>
            <div class="form-item">
                <textarea class="textarea code-input" id="ec-text" rows="4" placeholder="输入原文或密文..."></textarea>
            </div>
            <div class="toolbar" style="flex-wrap:wrap">
                <button class="btn btn-ghost btn-sm" data-ec="b64e">Base64 编码</button>
                <button class="btn btn-ghost btn-sm" data-ec="b64d">Base64 解码</button>
                <button class="btn btn-ghost btn-sm" data-ec="urle">URL 编码</button>
                <button class="btn btn-ghost btn-sm" data-ec="url">URL 解码</button>
                <button class="btn btn-ghost btn-sm" data-ec="hexe">Hex 编码</button>
                <button class="btn btn-ghost btn-sm" data-ec="hexd">Hex 解码</button>
                <button class="btn btn-ghost btn-sm" data-ec="unce">Unicode 转义</button>
                <button class="btn btn-ghost btn-sm" data-ec="unc">Unicode 还原</button>
                <button class="btn btn-ghost btn-sm" data-ec="ent">HTML 实体</button>
                <button class="btn btn-ghost btn-sm" data-ec="entd">实体还原</button>
            </div>
            ${outBox('ec-out')}
            <div class="toolbar">${copyBtn}</div>
        </div>

        <div class="card">
            <div class="card-header"><div><div class="card-title">对称加解密</div>
                <div class="card-desc">AES（CBC/ECB/CTR/GCM）· 3DES · RC4；口令自动补齐到密钥长度</div></div></div>
            <div class="form-row">
                <div class="form-item"><label>算法</label><select class="select" id="ci-alg"></select></div>
                <div class="form-item"><label>输入编码</label><select class="select" id="ci-denc"><option value="utf8">UTF-8</option><option value="base64">Base64</option><option value="hex">Hex</option></select></div>
                <div class="form-item"><label>输出</label><select class="select" id="ci-oenc"><option value="base64">Base64</option><option value="hex">Hex</option></select></div>
            </div>
            <div class="form-row">
                <div class="form-item"><label>密钥口令</label><input class="input mono" id="ci-key" placeholder="my-secret"></div>
                <div class="form-item"><label>IV（ECB 不需要）</label><input class="input mono" id="ci-iv" placeholder="16 字节，短于自动补零"></div>
                <div class="form-item"><label>IV 编码</label><select class="select" id="ci-ivenc"><option value="utf8">UTF-8</option><option value="base64">Base64</option><option value="hex">Hex</option></select></div>
            </div>
            <div class="form-item"><textarea class="textarea code-input" id="ci-text" rows="3" placeholder="待加密文本 / 待解密密文"></textarea></div>
            <div class="toolbar">
                <button class="btn btn-primary btn-sm" id="ci-enc">加密</button>
                <button class="btn btn-ghost btn-sm" id="ci-dec">解密</button>
                <span class="muted" id="ci-note" style="font-size:12px"></span>
            </div>
            ${outBox('ci-out')}
        </div>

        <div class="card">
            <div class="card-header"><div><div class="card-title">JWT 解析与验签</div>
                <div class="card-desc">解码 header / payload；提供密钥时校验 HS256/384/512 签名</div></div></div>
            <div class="form-item"><textarea class="textarea code-input" id="jwt-token" rows="3" placeholder="eyJhbGciOiJIUzI1NiIs..."></textarea></div>
            <div class="toolbar">
                <input class="input mono" id="jwt-secret" placeholder="验签密钥（可留空）" style="flex:1">
                <button class="btn btn-primary btn-sm" id="jwt-run">解析</button>
            </div>
            <div id="jwt-result"></div>
        </div>

        <div class="card">
            <div class="card-header"><div><div class="card-title">随机生成</div>
                <div class="card-desc">强随机：密码 / UUID / 随机密钥（Hex）</div></div></div>
            <div class="form-row">
                <div class="form-item"><label>密码长度</label><input class="input" id="rg-len" type="number" min="4" max="128" value="16"></div>
                <div class="form-item"><label>字符集</label><select class="select" id="rg-set">
                    <option value="full">字母数字+符号</option><option value="alnum">仅字母数字</option><option value="hexc">仅十六进制</option>
                </select></div>
            </div>
            <div class="toolbar">
                <button class="btn btn-ghost btn-sm" id="rg-pwd">生成密码</button>
                <button class="btn btn-ghost btn-sm" id="rg-uuid">生成 UUID</button>
                <button class="btn btn-ghost btn-sm" id="rg-hex">随机 32 字节 Key</button>
            </div>
            ${outBox('rg-out')}
        </div>

        <div class="card">
            <div class="card-header"><div><div class="card-title">二维码</div>
                <div class="card-desc">生成：文本/链接 → 二维码图片；识别：上传图片解析内容</div></div>
                <span class="badge gray" id="qr-deps">依赖检查中</span></div>
            <div class="form-item"><textarea class="textarea" id="qr-text" rows="2" placeholder="要编码的文本或 URL"></textarea></div>
            <div class="toolbar">
                <input class="input" id="qr-size" type="number" min="120" max="1024" value="260" style="width:90px" title="图片尺寸 px">
                <button class="btn btn-primary btn-sm" data-write id="qr-gen">生成二维码</button>
            </div>
            <div class="toolbar">
                <input type="file" id="qr-file" accept="image/*" style="font-size:12px">
                <button class="btn btn-ghost btn-sm" data-write id="qr-decode">识别二维码</button>
            </div>
            <div id="qr-result" class="sec-qr-result"></div>
        </div>
    </div>`;
}

/* ------------------------------------------------------------------
 * 工具逻辑
 * ------------------------------------------------------------------ */

function setOut(id, text) {
    const el = root.querySelector('#' + id);
    el.textContent = text || '—';
}

async function runHash() {
    const text = root.querySelector('#sh-text').value;
    const res = await api.sec.hash({ text, inputEncoding: root.querySelector('#sh-enc').value });
    if (!res || !res.ok) { toast((res && res.message) || '计算失败', 'danger'); return; }
    const table = root.querySelector('#sh-table');
    table.style.display = '';
    Object.entries(res.hashes).forEach(([algo, value]) => {
        table.querySelector(`[data-h="${algo}"]`).textContent = value;
    });
}

function runEncode(kind) {
    const src = root.querySelector('#ec-text').value;
    const tries = {
        b64e: () => b64Encode(src),
        b64d: () => b64Decode(src),
        urle: () => encodeURIComponent(src),
        url: () => decodeURIComponent(src),
        hexe: () => Array.from(new TextEncoder().encode(src)).map(b => b.toString(16).padStart(2, '0')).join(''),
        hexd: () => new TextDecoder().decode(Uint8Array.from(src.match(/.{2}/g) || [], h => parseInt(h, 16))),
        unce: () => src.replace(/[^\x00-\x7f]/g, c => '\\u' + c.charCodeAt(0).toString(16).padStart(4, '0')),
        unc: () => src.replace(/\\u([0-9a-fA-F]{4})/g, (_, h) => String.fromCharCode(parseInt(h, 16))),
        ent: () => src.replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])),
        entd: () => { const t = document.createElement('textarea'); t.innerHTML = src; return t.value; }
    };
    try { setOut('ec-out', tries[kind]()); }
    catch (e) { toast('转换失败：输入不是该编码的合法内容', 'warn'); }
}

async function runCipher(mode) {
    const payload = {
        mode,
        algorithm: root.querySelector('#ci-alg').value,
        key: root.querySelector('#ci-key').value,
        iv: root.querySelector('#ci-iv').value,
        ivEncoding: root.querySelector('#ci-ivenc').value,
        data: root.querySelector('#ci-text').value,
        dataEncoding: root.querySelector('#ci-denc').value,
        outEncoding: mode === 'decrypt' ? 'utf8' : root.querySelector('#ci-oenc').value
    };
    const res = await api.sec.cipher(payload);
    if (res && res.ok) {
        setOut('ci-out', res.result);
        root.querySelector('#ci-note').textContent = res.note || '';
    } else {
        setOut('ci-out', '');
        root.querySelector('#ci-note').textContent = '';
        toast((res && res.message) || '运算失败', 'danger');
    }
}

async function runJwt() {
    const res = await api.sec.jwt({ token: root.querySelector('#jwt-token').value, secret: root.querySelector('#jwt-secret').value });
    const box = root.querySelector('#jwt-result');
    if (!res || !res.ok) { box.innerHTML = `<div class="alert danger"><span>${esc((res && res.message) || '解析失败')}</span></div>`; return; }
    const verdict = res.valid === true ? '<span class="badge green">签名有效</span>'
        : res.valid === false ? '<span class="badge red">签名不符</span>'
            : (res.verifyNote ? `<span class="badge gray">${esc(res.verifyNote)}</span>` : '<span class="badge gray">未验签</span>');
    box.innerHTML = `
        ${verdict}
        <div class="muted" style="font-size:12px;margin:8px 0 2px">Header</div>
        <pre class="code-output">${esc(JSON.stringify(res.header, null, 2))}</pre>
        <div class="muted" style="font-size:12px;margin:8px 0 2px">Payload</div>
        <pre class="code-output">${esc(JSON.stringify(res.payload, null, 2))}</pre>`;
}

function randFrom(set, len) {
    const bytes = new Uint32Array(len);
    crypto.getRandomValues(bytes);
    return Array.from(bytes, b => set[b % set.length]).join('');
}

function runRandom(kind) {
    if (kind === 'uuid') { setOut('rg-out', crypto.randomUUID()); return; }
    if (kind === 'hex') {
        const bytes = new Uint8Array(32);
        crypto.getRandomValues(bytes);
        setOut('rg-out', Array.from(bytes, b => b.toString(16).padStart(2, '0')).join(''));
        return;
    }
    const len = Math.min(128, Math.max(4, Number(root.querySelector('#rg-len').value) || 16));
    const set = {
        full: 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789!@#$%^&*',
        alnum: 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789',
        hexc: '0123456789abcdef'
    }[root.querySelector('#rg-set').value] || 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789';
    setOut('rg-out', randFrom(set, len));
}

async function runQrGenerate() {
    if (!guardAdmin('生成二维码')) return;
    const text = root.querySelector('#qr-text').value;
    if (!text.trim()) { toast('请输入要编码的内容', 'warn'); return; }
    const res = await api.sec.qr.generate({ text, size: Number(root.querySelector('#qr-size').value) || 260 });
    const box = root.querySelector('#qr-result');
    if (res && res.ok) {
        box.innerHTML = `<img src="${res.dataUrl}" alt="二维码" class="sec-qr-img">
            <a class="btn btn-ghost btn-sm" href="${res.dataUrl}" download="qrcode.png">下载 PNG</a>`;
    } else {
        box.innerHTML = `<div class="alert warn"><span>${esc((res && res.message) || '生成失败')}</span></div>`;
    }
}

async function runQrDecode() {
    if (!guardAdmin('识别二维码')) return;
    const file = root.querySelector('#qr-file').files[0];
    if (!file) { toast('请先选择图片文件', 'warn'); return; }
    const dataUrl = await new Promise((resolve, reject) => {
        const fr = new FileReader();
        fr.onload = () => resolve(fr.result);
        fr.onerror = () => reject(fr.error);
        fr.readAsDataURL(file);
    }).catch(() => null);
    const box = root.querySelector('#qr-result');
    if (!dataUrl) { box.innerHTML = '<div class="alert danger"><span>图片读取失败</span></div>'; return; }
    box.innerHTML = `<div class="muted" style="font-size:12px">解码中...</div>`;
    const res = await api.sec.qr.decode({ image: dataUrl });
    box.innerHTML = res && res.ok
        ? `<div class="alert success"><span><strong>识别结果：</strong><span class="mono">${esc(res.text)}</span></span></div>`
        : `<div class="alert warn"><span>${esc((res && res.message) || '识别失败')}</span></div>`;
}

/* ------------------------------------------------------------------
 * 挂载
 * ------------------------------------------------------------------ */

export async function mount(r) {
    root = r;

    root.querySelector('#sh-run').addEventListener('click', runHash);
    root.querySelectorAll('[data-ec]').forEach(btn => btn.addEventListener('click', () => runEncode(btn.dataset.ec)));
    root.querySelector('#ci-enc').addEventListener('click', () => runCipher('encrypt'));
    root.querySelector('#ci-dec').addEventListener('click', () => runCipher('decrypt'));
    root.querySelector('#jwt-run').addEventListener('click', runJwt);
    root.querySelector('#rg-pwd').addEventListener('click', () => runRandom('pwd'));
    root.querySelector('#rg-uuid').addEventListener('click', () => runRandom('uuid'));
    root.querySelector('#rg-hex').addEventListener('click', () => runRandom('hex'));
    root.querySelector('#qr-gen').addEventListener('click', runQrGenerate);
    root.querySelector('#qr-decode').addEventListener('click', runQrDecode);

    root.addEventListener('click', e => {
        const btn = e.target.closest('.sec-copy');
        if (!btn) return;
        const scope = btn.closest('.card') || btn.closest('.toolbar').parentElement;
        const text = scope.querySelector('.sec-out') ? scope.querySelector('.sec-out').textContent
            : (btn.closest('tr') ? btn.closest('tr').querySelector('.mono').textContent : '');
        if (text && text !== '—') {
            navigator.clipboard.writeText(text).then(() => toast('已复制', 'success'), () => toast('复制失败', 'warn'));
        }
    });

    try {
        const algs = await api.sec.ciphers();
        root.querySelector('#ci-alg').innerHTML = (algs || ['AES-256-CBC']).map(a => `<option>${esc(a)}</option>`).join('');
    } catch (err) { /* 演示回退已兜底 */ }

    try {
        const d = await api.sec.drivers();
        const badge = root.querySelector('#qr-deps');
        const missing = [];
        if (!d.qrcode) missing.push('qrcode');
        if (!d.jimp || !d.jsqr) missing.push('jimp', 'jsqr');
        if (missing.length) {
            badge.className = 'badge amber';
            badge.textContent = `缺依赖：npm i ${[...new Set(missing)].join(' ')}`;
            badge.title = '二维码功能不可用，其余工具不受影响';
        } else {
            badge.className = 'badge green';
            badge.textContent = '二维码依赖就绪';
        }
    } catch (err) { /* ignore */ }
}
