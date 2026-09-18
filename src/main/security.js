/**
 * 命令安全校验模块
 * 流程：白名单命中 → 直接放行；黑名单命中 → 拦截并留痕；均未命中 → 通过
 */
const store = require('./store');
const audit = require('./auditLogger');
const alerts = require('./alerts');

function compile(pattern) {
    try {
        return new RegExp(pattern);
    } catch (e) {
        return null;
    }
}

/**
 * 执行前预校验
 * @param {string} cmd 待执行命令
 * @param {{user?:string, source?:string}} ctx 上下文（用于审计）
 * @returns {{ok:boolean, blocked:boolean, whitelisted:boolean, hits:Array, reason:string}}
 */
function validate(cmd, ctx = {}) {
    const command = String(cmd || '').trim();
    const config = store.get('config') || {};
    const rules = store.list('rules').filter(r => r.enabled);

    // 1) 白名单
    if (config.whitelistEnabled !== false) {
        const wl = rules.filter(r => r.mode === 'whitelist');
        for (const rule of wl) {
            const re = compile(rule.pattern);
            if (re && re.test(command)) {
                rule.hits = (rule.hits || 0) + 1;
                rules.length && store.persist();
                return {
                    ok: true, blocked: false, whitelisted: true,
                    hits: [{ pattern: rule.pattern, desc: rule.desc, level: rule.level }],
                    reason: `白名单放行（命中规则「${rule.desc}」）`
                };
            }
        }
    }

    // 2) 黑名单
    const hits = [];
    for (const rule of rules.filter(r => r.mode === 'blacklist')) {
        const re = compile(rule.pattern);
        if (re && re.test(command)) {
            rule.hits = (rule.hits || 0) + 1;
            hits.push({ pattern: rule.pattern, desc: rule.desc, level: rule.level });
        }
    }

    if (hits.length) {
        store.persist();
        const detail = `命令 "${command}" 命中 ${hits.length} 条敏感规则：`
            + hits.map(h => `[${h.level}] ${h.desc}`).join('、');
        // 拦截留痕（审计日志）
        audit.write({
            type: '拦截', level: 'danger', user: ctx.user || (store.get('config') || {}).currentUser,
            source: ctx.source || '本机', detail, result: 'blocked'
        });
        // 高危命令触发告警中心（5 分钟内同规则去重）
        alerts.add({
            level: hits.some(h => h.level === '高危') ? 'danger' : 'warn',
            title: `高危命令被拦截：${hits[0].desc}`,
            detail,
            source: 'security:' + hits[0].pattern
        });
        return {
            ok: false, blocked: true, whitelisted: false, hits,
            reason: '命令已拦截：' + hits.map(h => `[${h.level}] ${h.desc}`).join('、')
        };
    }

    return { ok: true, blocked: false, whitelisted: false, hits: [], reason: '校验通过：未命中敏感规则' };
}

module.exports = { validate };
