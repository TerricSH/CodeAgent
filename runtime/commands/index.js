// 命令注册表（宿主通用机制）：mainloop 只认这个泛化入口，不感知具体有哪些命令。
// 新增命令模块只需实现 { match(text), run(text, ctx) -> { handled, message? } } 并在此注册一行。
const sessionCommands = require('./session');
const workspaceCommands = require('./workspace');

const registry = [sessionCommands, workspaceCommands];

// 返回 { handled, message? }；未命中任何命令则 handled=false，交回普通对话流程。
async function dispatch(text, ctx) {
    for (const command of registry) {
        if (command.match(text)) {
            return await command.run(text, ctx);
        }
    }
    return { handled: false };
}

// 将结构化事件（如 runtime.applyPending 的结果）交由负责的命令模块格式化为显示文本。
function presentEvent(event, ctx) {
    for (const command of registry) {
        if (command.presents && command.presents(event)) {
            return command.present(event, ctx);
        }
    }
    return null;
}

module.exports = { dispatch, presentEvent, registry };
