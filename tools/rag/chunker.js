function normalizeText(value) {
    return String(value || '')
        .replace(/\r\n?/g, '\n')
        .replace(/[ \t]+\n/g, '\n')
        .replace(/\n{3,}/g, '\n\n')
        .trim();
}

function chooseBoundary(text, start, targetEnd, minimumEnd) {
    const preferred = ['\n\n', '\n', '。', '！', '？', '. ', '! ', '? ', '; ', '；', ' '];
    for (const separator of preferred) {
        const index = text.lastIndexOf(separator, targetEnd);
        if (index >= minimumEnd && index >= start) {
            return Math.min(text.length, index + separator.length);
        }
    }
    return targetEnd;
}

function chunkText(value, options = {}) {
    const text = normalizeText(value);
    if (!text) return [];

    const chunkSize = Number.isInteger(options.chunkSize) && options.chunkSize > 0
        ? options.chunkSize
        : 1200;
    const overlap = Number.isInteger(options.overlap) && options.overlap >= 0
        ? Math.min(options.overlap, chunkSize - 1)
        : Math.min(200, chunkSize - 1);
    const chunks = [];
    let start = 0;

    while (start < text.length) {
        const targetEnd = Math.min(text.length, start + chunkSize);
        const minimumEnd = Math.min(targetEnd, start + Math.floor(chunkSize * 0.55));
        const end = targetEnd < text.length
            ? chooseBoundary(text, start, targetEnd, minimumEnd)
            : targetEnd;
        const raw = text.slice(start, end);
        const leading = raw.length - raw.trimStart().length;
        const trailing = raw.length - raw.trimEnd().length;
        const content = raw.trim();

        if (content) {
            chunks.push({
                index: chunks.length,
                content,
                charStart: start + leading,
                charEnd: end - trailing,
            });
        }
        if (end >= text.length) break;
        start = Math.max(start + 1, end - overlap);
    }

    return chunks;
}

module.exports = { chunkText, normalizeText };
