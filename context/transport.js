// Atomic Tool-span validation shared by Context assembly tests and provider adapters.
// Dynamic selection and token budgeting live in token-controller.js; there is no
// transport-overlay path and no second history representation here.

function hasDanglingTool(messages = []) {
    const declared = new Set();
    for (const message of messages) {
        if (message.role === 'assistant' && Array.isArray(message.tool_calls)) {
            for (const toolCall of message.tool_calls) {
                if (toolCall?.id) declared.add(toolCall.id);
            }
        }
        if (message.role === 'tool' && !declared.has(message.tool_call_id)) return true;
    }
    return false;
}

module.exports = { hasDanglingTool };
