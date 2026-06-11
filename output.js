class Output {
    constructor(stream) {
        this.stream = stream || process.stdout;
    }

    write(text) {
        this.stream.write(text);
    }

    writeLine(text) {
        this.stream.write(text + '\n');
    }

    async renderStream(chunks) {
        let reply = '';
        let inThinking = false;

        for await (const chunk of chunks) {
            if (chunk.type === 'thinking') {
                if (!inThinking) {
                    inThinking = true;
                    this.write('思考中: ');
                }
                this.write(chunk.content);
            } else if (chunk.type === 'content') {
                if (inThinking) {
                    inThinking = false;
                    this.write('\n\nAI: ');
                } else if (!reply) {
                    this.write('AI: ');
                }
                this.write(chunk.content);
                reply += chunk.content;
            }
        }
        this.writeLine('\n');
        return reply;
    }

    error(msg) {
        this.writeLine(`\n错误: ${msg}\n`);
    }

    toolCall(name, args) {
        this.writeLine(`\n[调用工具] ${name}(${JSON.stringify(args)})`);
    }

    toolResult(name, result) {
        const preview = result.length > 200 ? result.slice(0, 200) + '...' : result;
        this.writeLine(`[工具结果] ${name}: ${preview}\n`);
    }
}

module.exports = Output;
