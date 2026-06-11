function loadOutput(mode) {
    // 内置实现
    try { return require(`./${mode}`); } catch { }
    // 外部 npm 包
    try { return require(`codeagent-output-${mode}`); } catch { }
    throw new Error(`未找到输出插件: ${mode}`);
}

module.exports = loadOutput(process.env.OUTPUT_MODE || 'cli');
