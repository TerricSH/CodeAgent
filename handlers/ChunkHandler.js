class ChunkHandler {
    constructor(output) {
        this.output = output;
    }

    handle(event, state) {
        throw new Error('子类必须实现 handle 方法');
    }
}

module.exports = ChunkHandler;
