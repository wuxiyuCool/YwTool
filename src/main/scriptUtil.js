/**
 * 脚本包装工具：把脚本内容安全地转为可远程执行的命令
 */

/** Shell：heredoc 方式交给远端 bash 执行，避免引号转义问题 */
function wrapShell(content) {
    return `bash -s <<'SGOPS_EOF'\n${content}\nSGOPS_EOF`;
}

/** Python：写入临时文件后执行，执行完清理 */
function wrapPython(content) {
    return [
        "cat > /tmp/sgops_task.py <<'SGOPS_EOF'",
        content,
        'SGOPS_EOF',
        'python3 /tmp/sgops_task.py; _rc=$?; rm -f /tmp/sgops_task.py; exit $_rc'
    ].join('\n');
}

/**
 * 根据脚本类型生成远程命令
 * @param {{type:string, content:string}} script
 */
function buildScriptCommand(script) {
    if (script.type === 'compose') {
        throw new Error('compose 编排文件请在「服务器运维 → 容器运维」页执行，不走远程脚本通道');
    }
    return script.type === 'python' ? wrapPython(script.content) : wrapShell(script.content);
}

module.exports = { wrapShell, wrapPython, buildScriptCommand };
