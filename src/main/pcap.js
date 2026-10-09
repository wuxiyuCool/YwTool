/**
 * 流量包分析（类 Wireshark，主进程，零新增依赖）
 * ------------------------------------------------------------------
 * 1. 打开 .pcap / .pcapng 文件：自研解析 libpcap 记录与 pcapng SHB/IDB/EPB 块，
 *    解码 Ethernet/SLL/RAW-IP → IPv4/IPv6 → TCP/UDP/ICMP/ARP，识别 HTTP/DNS/TLS(SNI) 摘要。
 * 2. 实时抓包（可选）：探测本机 Wireshark 的 tshark/dumpcap 子进程捕获到临时 pcap，
 *    轮询增量解析并推送；未安装时给出明确指引（npm 生态无可用的纯 JS 实时抓包方案）。
 * 3. detail(no)：协议树 + 十六进制；followStream(no)：TCP 流双向重组。
 *
 * 边界：不解析 802.11/VPN 封装等冷门链路；分片 IP 只展示到网络层；
 *      TLS 仅提取 ClientHello SNI，不做解密。
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn, execFile } = require('child_process');

const MAX_FILE_BYTES = 256 * 1024 * 1024;   // 256MB 文件上限
const MAX_PACKETS = 50000;                  // 解析报文上限（超出截断并提示）
const HEX_LIMIT = 4096;                     // 单包 hex 展示上限
const STREAM_CAP = 512 * 1024;              // 每方向流重组上限
const LIVE_POLL_MS = 2500;                  // 实时抓包轮询间隔

let session = null;   // { file, packets, raws, flows:Map, linktypes:Map(ifaceId→lt), truncated, openedAt }
let live = null;      // { child, file, emitted, timer, emitter }
let pushEvent = () => {};

/* ================= 基础格式化 ================= */

const hex = (n, w) => n.toString(16).padStart(w, '0');
const fmtMac = b => Array.from(b, x => hex(x, 2)).join(':');
const fmtIp4 = (buf, off) => `${buf[off]}.${buf[off + 1]}.${buf[off + 2]}.${buf[off + 3]}`;
function fmtIp6(buf, off) {
    const parts = [];
    for (let i = 0; i < 16; i += 2) parts.push(hex(buf.readUInt16BE(off + i), 4));
    return parts.join(':').replace(/(^|:)0+([0-9a-f])/, '$1$2');
}

const HTTP_METHODS = /^(GET|POST|PUT|DELETE|HEAD|OPTIONS|PATCH|TRACE|CONNECT) /;
const TCP_FLAGS = (f) => {
    const s = [];
    if (f & 0x02) s.push('SYN'); if (f & 0x10) s.push('ACK'); if (f & 0x01) s.push('FIN');
    if (f & 0x04) s.push('RST'); if (f & 0x08) s.push('PSH'); if (f & 0x20) s.push('URG');
    return s.join(',') || '.';
};

/* ================= 帧解码 ================= */

/** 链路层 → 网络层；返回 { src, dst, l3, ethertype, off } 或 null */
function decodeLink(buf, linktype) {
    if (buf.length < 4) return null;
    if (linktype === 1) {                        // Ethernet
        if (buf.length < 14) return null;
        let type = buf.readUInt16BE(12);
        let off = 14;
        while ((type === 0x8100 || type === 0x88a8) && buf.length >= off + 4) {   // VLAN
            type = buf.readUInt16BE(off + 2);
            off += 4;
        }
        return { src: fmtMac(buf.subarray(6, 12)), dst: fmtMac(buf.subarray(0, 6)), l3: type, off };
    }
    if (linktype === 113) {                      // Linux SLL cooked
        if (buf.length < 16) return null;
        return { src: '', dst: '', l3: buf.readUInt16BE(14), off: 16 };
    }
    if (linktype === 276) {                      // Linux SLL2
        if (buf.length < 20) return null;
        return { src: '', dst: '', l3: buf.readUInt16BE(0), off: 20 };
    }
    if (linktype === 0 || linktype === 12) {     // BSD loopback（4 字节 AF，网络序）
        const af = buf.readUInt32BE(0);
        return { src: '', dst: '', l3: af === 2 ? 0x0800 : af === 24 || af === 28 || af === 30 ? 0x86dd : 0, off: 4 };
    }
    if (linktype === 101) {                      // RAW IP
        return { src: '', dst: '', l3: (buf[0] >> 4) === 6 ? 0x86dd : 0x0800, off: 0 };
    }
    return null;
}

/** IPv4/IPv6 → 传输层；返回 { proto(name), src, dst, l4proto, off, l4len, frag } */
function decodeNet(buf, l3, off) {
    if (l3 === 0x0800) {
        if (buf.length < off + 20) return null;
        const ihl = (buf[off] & 0x0f) * 4;
        const frag = buf.readUInt16BE(off + 6) & 0x1fff;
        return {
            src: fmtIp4(buf, off + 12), dst: fmtIp4(buf, off + 16),
            l4proto: buf[off + 9], off: off + ihl, frag: frag !== 0,
            dscpTtl: `ttl=${buf[off + 8]}`
        };
    }
    if (l3 === 0x86dd) {
        if (buf.length < off + 40) return null;
        let next = buf[off + 6];
        let p = off + 40;
        // 顺序遍历常见扩展头，遇到分片/ESP 停止 L4 解析
        while ([0, 43, 60, 51].includes(next) && buf.length >= p + 2) {
            const extLen = (buf[p + 1] + 1) * 8;
            next = buf[p];
            p += extLen;
        }
        const frag = next === 44;
        if (next === 44) next = 59;
        return {
            src: fmtIp6(buf, off + 8), dst: fmtIp6(buf, off + 24),
            l4proto: next, off: p, frag, dscpTtl: `hop=${buf[off + 7]}`
        };
    }
    if (l3 === 0x0806) return { src: 'ARP', dst: '', l4proto: -2, off, frag: false };
    return null;
}

/** 提取 DNS 首个问题名 */
function dnsQuery(buf, off) {
    try {
        let p = off + 12;
        let name = '';
        while (p < buf.length) {
            const len = buf[p];
            if (len === 0) { p++; break; }
            if (len >= 0xc0) { p += 2; break; }    // 压缩指针（仅首问之前不会出现）
            name += buf.subarray(p + 1, p + 1 + len).toString('latin1') + '.';
            p += 1 + len;
        }
        const qtype = buf.readUInt16BE(p);
        const types = { 1: 'A', 28: 'AAAA', 5: 'CNAME', 12: 'PTR', 15: 'MX', 16: 'TXT' };
        return { qname: name.replace(/\.$/, ''), qtype: types[qtype] || `TYPE${qtype}` };
    } catch (e) { return null; }
}

/** 提取 TLS ClientHello SNI */
function tlsSni(buf, off) {
    try {
        if (buf[off] !== 0x16) return null;                       // 非 Handshake record
        let p = off + 5;                                          // record header
        if (buf[p] !== 0x01) return null;                         // 非 ClientHello
        p += 4;                                                   // type + length(3)
        p += 2 + 32;                                              // version + random
        p += 1 + buf[p];                                          // session id
        p += 2 + buf.readUInt16BE(p);                             // cipher suites
        p += 1 + buf[p];                                          // compression
        const extEnd = p + 2 + buf.readUInt16BE(p);
        p += 2;
        while (p + 4 <= Math.min(extEnd, buf.length)) {
            const type = buf.readUInt16BE(p);
            const len = buf.readUInt16BE(p + 2);
            if (type === 0 && len > 5) {                          // server_name
                const nameLen = buf.readUInt16BE(p + 7 + 2);
                return buf.subarray(p + 9 + 2, p + 9 + 2 + nameLen).toString('latin1');
            }
            p += 4 + len;
        }
    } catch (e) { /* 结构不完整 */ }
    return null;
}

/** 单帧 → meta + 协议树 */
function decodeFrame(buf, linktype) {
    const layers = [];
    const link = decodeLink(buf, linktype);
    if (!link) return { proto: 'LINK', src: '', dst: '', info: '未支持链路层', layers, flow: null, payload: null };
    layers.push({ name: linktype === 1 ? 'Ethernet II' : '链路层', fields: [
        link.src && { k: 'Source', v: link.src }, link.dst && { k: 'Destination', v: link.dst },
        { k: 'Type', v: '0x' + hex(link.l3, 4) }
    ].filter(Boolean) });
    if (link.l3 === 0x0806 && buf.length >= link.off + 28) {
        const sender = fmtIp4(buf, link.off + 14), target = fmtIp4(buf, link.off + 24);
        const op = buf.readUInt16BE(link.off + 6);
        return {
            proto: 'ARP', src: sender, dst: target, info: op === 1 ? `who-has ${target} tell ${sender}` : `reply ${sender} is-at …`,
            layers, flow: 'ARP', payload: null
        };
    }
    const net = decodeNet(buf, link.l3, link.off);
    if (!net) return { proto: 'NET', src: '', dst: '', info: '未支持网络层', layers, flow: null, payload: null };
    layers.push({ name: link.l3 === 0x0800 ? 'IPv4' : 'IPv6', fields: [
        { k: 'Src', v: net.src }, { k: 'Dst', v: net.dst }, { k: 'Proto/TTL', v: `${net.l4proto} ${net.dscpTtl}` }
    ] });
    if (net.frag) {
        return { proto: 'IP', src: net.src, dst: net.dst, info: '分片报文（不解析上层）', layers, flow: `${net.src}↔${net.dst}`, payload: null };
    }
    if (net.l4proto === 1) {                                      // ICMP
        const p = net.off;
        if (buf.length >= p + 4) {
            const type = buf[p], code = buf[p + 1];
            const names = { 0: 'Echo Reply', 3: 'Dest Unreachable', 8: 'Echo Request', 5: 'Redirect' };
            layers.push({ name: 'ICMP', fields: [{ k: 'Type', v: `${type} (${names[type] || 'other'})` }, { k: 'Code', v: String(code) }] });
            return { proto: 'ICMP', src: net.src, dst: net.dst, info: names[type] || `type=${type}`, layers, flow: `ICMP ${net.src}↔${net.dst}`, payload: null };
        }
    }
    if (net.l4proto === 6 || net.l4proto === 17) {                // TCP / UDP
        const tcp = net.l4proto === 6;
        const p = net.off;
        if (buf.length < p + 8) return { proto: tcp ? 'TCP' : 'UDP', src: net.src, dst: net.dst, info: '头部不完整', layers, flow: null, payload: null };
        const sport = buf.readUInt16BE(p), dport = buf.readUInt16BE(p + 2);
        let payloadOff = -1, payloadBuf = null, l4Layer = null;
        if (tcp) {
            const dataOff = (buf[p + 12] >> 4) * 4;
            const flags = buf[p + 13];
            l4Layer = { name: 'TCP', fields: [
                { k: 'Port', v: `${sport} → ${dport}` }, { k: 'Flags', v: TCP_FLAGS(flags) },
                { k: 'Seq/Ack', v: `${buf.readUInt32BE(p + 4)} / ${buf.readUInt32BE(p + 8)}` },
                { k: 'Window', v: String(buf.readUInt16BE(p + 14)) }
            ] };
            if (buf.length > p + dataOff) { payloadOff = p + dataOff; payloadBuf = buf.subarray(payloadOff); }
        } else {
            l4Layer = { name: 'UDP', fields: [{ k: 'Port', v: `${sport} → ${dport}` }, { k: 'Len', v: String(buf.readUInt16BE(p + 4)) }] };
            if (buf.length > p + 8) { payloadOff = p + 8; payloadBuf = buf.subarray(payloadOff); }
        }
        layers.push(l4Layer);
        // 规范化流 key：两端点排序后拼接，天然双向同 key
        const epA = `${net.src}:${sport}`, epB = `${net.dst}:${dport}`;
        const flow = `${tcp ? 'T' : 'U'}:${epA < epB ? epA + '-' + epB : epB + '-' + epA}`;

        // 应用层识别
        let proto = tcp ? 'TCP' : 'UDP';
        let info = tcp ? TCP_FLAGS(buf[p + 13]) : `${sport}→${dport}`;
        if (payloadBuf && payloadBuf.length) {
            const head = payloadBuf.subarray(0, 2);
            if (dport === 53 || sport === 53 || dport === 5353) {
                const q = dnsQuery(payloadBuf, 0);
                if (q) { proto = 'DNS'; info = `query ${q.qtype} ${q.qname}`; }
            } else if (HTTP_METHODS.test(payloadBuf.subarray(0, 40).toString('latin1')) || payloadBuf.subarray(0, 5).toString('latin1') === 'HTTP/') {
                const line = payloadBuf.subarray(0, 200).toString('latin1').split('\r\n')[0];
                proto = 'HTTP';
                info = line.length > 60 ? line.slice(0, 60) + '…' : line;
            } else if (head[0] === 0x16 || dport === 443 || sport === 443) {
                proto = 'TLS';
                const sni = head[0] === 0x16 ? tlsSni(payloadBuf, 0) : null;
                info = sni ? `ClientHello SNI=${sni}` : (dport === 443 || sport === 443 ? `${sport}→${dport} TLS` : 'TLS Handshake');
            } else if (dport === 80 || sport === 80) {
                proto = 'HTTP';
                info = `${sport}→${dport} ${payloadBuf.length}B`;
            } else {
                info = `${info} Len=${payloadBuf.length}`;
            }
        }
        return {
            proto, src: net.src, dst: net.dst, info, layers, flow,
            payload: payloadBuf ? { buf: payloadBuf, absOff: payloadOff } : null,
            sport, dport, tcp
        };
    }
    return { proto: 'IP', src: net.src, dst: net.dst, info: `proto=${net.l4proto}`, layers, flow: `${net.src}↔${net.dst}`, payload: null };
}

/* ================= 文件解析 ================= */

function parsePcap(buf) {
    const magic = buf.readUInt32LE(0);
    const be = magic === 0xd4c3b2a1 || magic === 0x3c4db2a1;
    const ns = magic === 0xa1b23c4d || magic === 0x3c4db2a1;
    const u16 = (o) => be ? buf.readUInt16BE(o) : buf.readUInt16LE(o);
    const u32 = (o) => be ? buf.readUInt32BE(o) : buf.readUInt32LE(o);
    const linktype = u32(20);
    const out = [];
    let p = 24;
    while (p + 16 <= buf.length && out.length < MAX_PACKETS) {
        const tsSec = u32(p), frac = u32(p + 4), caplen = u32(p + 8), origlen = u32(p + 12);
        if (caplen > buf.length - p - 16 || caplen > 0x100000) break;   // 截断/损坏
        out.push({ ts: tsSec * 1000 + (ns ? frac / 1e6 : frac / 1e3), caplen, origlen, data: buf.subarray(p + 16, p + 16 + caplen), linktype });
        p += 16 + caplen + ((4 - (caplen % 4)) % 4);
    }
    return { records: out, linktypes: new Map([[0, linktype]]), truncated: p < buf.length };
}

function parsePcapng(buf) {
    const out = [];
    const linktypes = new Map();
    const tsresol = new Map();
    // SHB 的 byte-order magic 固定在偏移 8：LE 读得 0x1A2B3C4D 即小端
    const le = buf.length >= 12 && buf.readUInt32LE(8) === 0x1a2b3c4d;
    const u32 = o => le ? buf.readUInt32LE(o) : buf.readUInt32BE(o);
    const u16 = o => le ? buf.readUInt16LE(o) : buf.readUInt16BE(o);
    let p = 0;
    while (p + 12 <= buf.length) {
        const btype = u32(p);
        const blen = u32(p + 4);
        if (blen < 12 || p + blen > buf.length) break;
        if (btype === 0x00000001) {                                     // IDB
            const ifaceCount = linktypes.size;
            linktypes.set(ifaceCount, u16(p + 8));
            // options：code u16 len u16 value…；9=if_tsresol
            let q = p + 20;
            while (q + 4 <= p + blen - 4) {
                const code = u16(q), len = u16(q + 2);
                if (code === 0) break;
                if (code === 9 && len >= 1) tsresol.set(ifaceCount, buf[q + 4] & 0x7f ? Math.pow(2, -(buf[q + 4] & 0x7f)) : Math.pow(10, -buf[q + 4]));
                q += 4 + len + ((4 - (len % 4)) % 4);
            }
        } else if (btype === 0x00000006) {                              // EPB：body 从 p+8 起，固定字段 20 字节 → 数据在 p+28
            const iface = u32(p + 8);
            const tsHigh = u32(p + 12), tsLow = u32(p + 16);
            const caplen = u32(p + 20), origlen = u32(p + 24);
            if (caplen <= blen - 32 && caplen < 0x100000) {
                const tsUnit = tsresol.get(iface) || 1e-6;
                const ts = (tsHigh * 4294967296 + tsLow) * tsUnit * 1000;
                out.push({ ts, caplen, origlen, data: buf.subarray(p + 28, p + 28 + caplen), linktype: linktypes.get(iface) || 1 });
            }
        }
        p += blen;
        if (out.length >= MAX_PACKETS) break;
    }
    return { records: out, linktypes, truncated: p < buf.length };
}

function buildSession(file, buf) {
    const magic = buf.length >= 4 ? buf.readUInt32LE(0) : 0;
    let parsed;
    if (magic === 0x0a0d0d0a) parsed = parsePcapng(buf);
    else if ([0xa1b2c3d4, 0xd4c3b2a1, 0xa1b23c4d, 0x3c4db2a1].includes(magic)) parsed = parsePcap(buf);
    else return { ok: false, message: '无法识别的文件头（非 pcap/pcapng 格式）' };

    const packets = [];
    const raws = [];
    const flows = new Map();
    parsed.records.forEach((rec, i) => {
        const d = decodeFrame(rec.data, rec.linktype);
        const meta = {
            no: i + 1, ts: Math.round(rec.ts), src: d.src, dst: d.dst, proto: d.proto,
            len: rec.origlen, caplen: rec.caplen, info: d.info, flow: d.flow || `solo-${i}`
        };
        packets.push(meta);
        raws.push({ data: rec.data, linktype: rec.linktype, decoded: d });
        if (!flows.has(meta.flow)) flows.set(meta.flow, []);
        flows.get(meta.flow).push(i);
    });
    return { ok: true, session: { file, packets, raws, flows, truncated: parsed.truncated || parsed.records.length >= MAX_PACKETS, openedAt: Date.now() } };
}

function openFile(filePath) {
    try {
        const stat = fs.statSync(filePath);
        if (stat.size > MAX_FILE_BYTES) return { ok: false, message: `文件超过 ${MAX_FILE_BYTES / 1024 / 1024}MB 上限` };
        const buf = fs.readFileSync(filePath);
        const res = buildSession(filePath, buf);
        if (!res.ok) return res;
        session = res.session;
        const first = session.packets[0], last = session.packets[session.packets.length - 1];
        return {
            ok: true, file: path.basename(filePath), count: session.packets.length,
            truncated: session.truncated,
            firstTs: first ? first.ts : 0, lastTs: last ? last.ts : 0,
            spanSec: first && last ? Math.round((last.ts - first.ts) / 100) / 10 : 0
        };
    } catch (err) {
        return { ok: false, message: '打开失败：' + err.message };
    }
}

const LIST_CAP = 20000;
function listPackets() {
    if (!session) return { ok: false, message: '尚未打开流量包' };
    return { ok: true, file: path.basename(session.file), packets: session.packets.slice(0, LIST_CAP), truncated: session.packets.length > LIST_CAP || session.truncated, count: session.packets.length };
}

function hexdump(buf) {
    const lines = [];
    const n = Math.min(buf.length, HEX_LIMIT);
    for (let i = 0; i < n; i += 16) {
        const bytes = buf.subarray(i, Math.min(i + 16, n));
        const hexPart = Array.from(bytes, b => hex(b, 2)).join(' ').padEnd(47, ' ');
        const ascii = Array.from(bytes, b => (b >= 32 && b < 127 ? String.fromCharCode(b) : '.')).join('');
        lines.push(`${hex(i, 8)}  ${hexPart}  ${ascii}`);
    }
    if (buf.length > HEX_LIMIT) lines.push(`… 共 ${buf.length} 字节，仅显示前 ${HEX_LIMIT}`);
    return lines.join('\n');
}

function getDetail(no) {
    if (!session) return { ok: false, message: '尚未打开流量包' };
    const i = Number(no) - 1;
    const raw = session.raws[i];
    if (!raw) return { ok: false, message: '报文不存在' };
    const meta = session.packets[i];
    const tree = raw.decoded.layers.map(l => ({ name: l.name, fields: l.fields.map(f => ({ k: f.k, v: f.v })) }));
    return { ok: true, meta, tree, hex: hexdump(raw.data) };
}

/** TCP 流双向重组（按 5 元组归并，seq 不严格校验，按抓包顺序拼接） */
function followStream(no) {
    if (!session) return { ok: false, message: '尚未打开流量包' };
    const i = Number(no) - 1;
    const meta = session.packets[i];
    if (!meta) return { ok: false, message: '报文不存在' };
    if (!meta.flow.startsWith('T:')) return { ok: false, message: '仅支持 TCP 流跟踪' };
    const idxs = session.flows.get(meta.flow) || [];
    const anchor = session.raws[idxs[0]].decoded;
    const aKey = `${anchor.src}:${anchor.sport}`;
    const aBuf = [], bBuf = [];
    let aBytes = 0, bBytes = 0, aCapped = false, bCapped = false;
    for (const j of idxs) {
        const r = session.raws[j];
        if (!r.decoded.payload || !r.decoded.payload.buf.length) continue;
        const from = `${r.decoded.src}:${r.decoded.sport}`;
        if (from === aKey) { if (aBytes < STREAM_CAP) { aBuf.push(r.decoded.payload.buf); aBytes += r.decoded.payload.buf.length; } else aCapped = true; }
        else { if (bBytes < STREAM_CAP) { bBuf.push(r.decoded.payload.buf); bBytes += r.decoded.payload.buf.length; } else bCapped = true; }
    }
    const toText = (chunks) => Buffer.concat(chunks).toString('utf8').replace(/\r\n/g, '\n');
    return {
        ok: true,
        a: { from: aKey, to: `${anchor.dst}:${anchor.dport}`, text: toText(aBuf), bytes: aBytes, capped: aCapped },
        b: { from: `${anchor.dst}:${anchor.dport}`, to: aKey, text: toText(bBuf), bytes: bBytes, capped: bCapped }
    };
}

function closeFile() {
    session = null;
    return { ok: true };
}

/* ================= 实时抓包（tshark/dumpcap 子进程） ================= */

const TOOL_NAMES = ['tshark.exe', 'dumpcap.exe'];
function findCaptureTool() {
    const dirs = [
        process.env['ProgramFiles'] ? path.join(process.env['ProgramFiles'], 'Wireshark') : '',
        process.env['ProgramFiles(x86)'] ? path.join(process.env['ProgramFiles(x86)'], 'Wireshark') : '',
        'C:\\Program Files\\Wireshark'
    ].filter(Boolean);
    for (const dir of dirs) {
        for (const name of TOOL_NAMES) {
            const p = path.join(dir, name);
            if (fs.existsSync(p)) return p;
        }
    }
    return null;    // PATH 兜底交给 spawn 的 ENOENT 处理
}

function toolInfo() {
    const p = findCaptureTool();
    return { ok: true, tool: p || null, hint: p ? '' : '未检测到 Wireshark 命令行工具（tshark/dumpcap）。实时抓包需安装 Wireshark（含 npcap 驱动）；也可先用 Wireshark 抓包保存为 .pcap 再用「打开流量包」分析' };
}

function listInterfaces() {
    return new Promise(resolve => {
        const tool = findCaptureTool();
        if (!tool) return resolve({ ok: false, message: '未检测到 tshark/dumpcap' });
        execFile(tool, ['-D'], { timeout: 8000 }, (err, stdout) => {
            if (err) return resolve({ ok: false, message: err.message });
            const ifaces = String(stdout).split('\n').map(line => {
                const m = /^\s*(\d+)\.\s+(\S+)\s+\(([^)]*)\)/.exec(line);
                return m ? { idx: Number(m[1]), name: m[2], desc: m[3] } : null;
            }).filter(Boolean);
            resolve({ ok: true, ifaces });
        });
    });
}

function liveStart(options = {}) {
    if (live) return { ok: false, message: '实时抓包已在进行' };
    const tool = findCaptureTool();
    if (!tool) return { ok: false, message: toolInfo().hint };
    const file = path.join(os.tmpdir(), `sgops-live-${Date.now()}.pcapng`);
    const args = ['-i', String(options.iface || '1'), '-w', file, '-q'];
    if (options.bpf) args.push('-f', String(options.bpf));
    let child;
    try {
        child = spawn(tool, args, { windowsHide: true });
    } catch (err) {
        return { ok: false, message: '启动失败：' + err.message };
    }
    live = { child, file, emitted: 0, stderr: '' };
    child.stderr.on('data', c => { live.stderr = (live.stderr + c.toString('utf8')).slice(-2000); });
    child.on('exit', () => { if (live && live.child === child) finalizeLive(false); });
    live.timer = setInterval(() => pumpLive(), LIVE_POLL_MS);
    // 以当前临时文件为 session，后续增量并入
    session = { file, packets: [], raws: [], flows: new Map(), truncated: false, openedAt: Date.now(), live: true };
    return { ok: true, file, tool: path.basename(tool) };
}

/** 重新读取（前缀完整的）抓包文件，把新增报文并入 session 并推送 */
function pumpLive() {
    if (!live || !session) return;
    let buf;
    try { buf = fs.readFileSync(live.file); } catch (e) { return; }   // 文件未生成/被占用
    if (!buf.length || buf.length < 12) return;
    if (buf.readUInt32LE(0) !== 0x0a0d0d0a) return;                   // dumpcap 尚未写出有效头
    const parsed = parsePcapng(buf);
    while (parsed.records.length > session.packets.length) {
        const i = session.packets.length;
        const rec = parsed.records[i];
        const d = decodeFrame(rec.data, rec.linktype);
        const meta = {
            no: i + 1, ts: Math.round(rec.ts), src: d.src, dst: d.dst, proto: d.proto,
            len: rec.origlen, caplen: rec.caplen, info: d.info, flow: d.flow || `solo-${i}`
        };
        session.packets.push(meta);
        session.raws.push({ data: rec.data, linktype: rec.linktype, decoded: d });
        if (!session.flows.has(meta.flow)) session.flows.set(meta.flow, []);
        session.flows.get(meta.flow).push(i);
        if (session.packets.length >= MAX_PACKETS) { stopLiveTimer(); return; }
    }
    if (session.packets.length > live.emitted) {
        pushEvent('live', { added: session.packets.slice(live.emitted), total: session.packets.length });
        live.emitted = session.packets.length;
    }
}

function stopLiveTimer() {
    if (live && live.timer) clearInterval(live.timer);
    if (live) live.timer = null;
}

function finalizeLive(manual) {
    if (!live) return;
    stopLiveTimer();
    const { child, file } = live;
    live = null;
    try { child.kill(); } catch (e) { /* 已退出 */ }
    try { pumpLiveOnceForFinal(file); } catch (e) { /* ignore */ }
    void manual;
}

function pumpLiveOnceForFinal(file) {
    let buf;
    try { buf = fs.readFileSync(file); } catch (e) { return; }
    if (!buf.length || buf.readUInt32LE(0) !== 0x0a0d0d0a || !session) return;
    const parsed = parsePcapng(buf);
    while (parsed.records.length > session.packets.length) {
        const i = session.packets.length;
        const rec = parsed.records[i];
        const d = decodeFrame(rec.data, rec.linktype);
        const meta = { no: i + 1, ts: Math.round(rec.ts), src: d.src, dst: d.dst, proto: d.proto, len: rec.origlen, caplen: rec.caplen, info: d.info, flow: d.flow || `solo-${i}` };
        session.packets.push(meta);
        session.raws.push({ data: rec.data, linktype: rec.linktype, decoded: d });
        if (!session.flows.has(meta.flow)) session.flows.set(meta.flow, []);
        session.flows.get(meta.flow).push(i);
    }
    if (session.packets.length > 0) pushEvent('live', { added: [], total: session.packets.length, finished: true });
}

function liveStop() {
    if (!live) return { ok: true, message: '未在抓包' };
    finalizeLive(true);
    return { ok: true, count: session ? session.packets.length : 0 };
}

module.exports = {
    setEmitter: fn => { pushEvent = fn; },
    openFile, listPackets, getDetail, followStream, closeFile,
    toolInfo, listInterfaces, liveStart, liveStop
};
