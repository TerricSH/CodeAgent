const crypto = require('node:crypto');
const fs = require('node:fs');

function detectMimeType(buffer) {
    if (buffer.length >= 8 && buffer.subarray(0, 8).equals(
        Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
    )) return 'image/png';
    if (buffer.length >= 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) {
        return 'image/jpeg';
    }
    if (
        buffer.length >= 12
        && buffer.subarray(0, 4).toString('ascii') === 'RIFF'
        && buffer.subarray(8, 12).toString('ascii') === 'WEBP'
    ) return 'image/webp';
    const header = buffer.subarray(0, 6).toString('ascii');
    if (header === 'GIF87a' || header === 'GIF89a') return 'image/gif';
    return null;
}

function pngDimensions(buffer) {
    if (buffer.length < 24) return null;
    return { width: buffer.readUInt32BE(16), height: buffer.readUInt32BE(20) };
}

function gifDimensions(buffer) {
    if (buffer.length < 10) return null;
    return { width: buffer.readUInt16LE(6), height: buffer.readUInt16LE(8) };
}

function imageDimensions(buffer, mimeType) {
    if (mimeType === 'image/png') return pngDimensions(buffer);
    if (mimeType === 'image/gif') return gifDimensions(buffer);
    return null;
}

function normalizePaths(imagePaths, maxImages) {
    if (!Array.isArray(imagePaths) || imagePaths.length === 0) {
        throw new TypeError('imagePaths must be a non-empty array');
    }
    if (imagePaths.length > maxImages) {
        throw new Error(`At most ${maxImages} images may be inspected in one request`);
    }
    return imagePaths.map((value, index) => {
        if (typeof value !== 'string' || !value.trim()) {
            throw new TypeError(`imagePaths[${index}] must be a non-empty path`);
        }
        return value.trim();
    });
}

function loadImages(imagePaths, fileSystem, config) {
    const paths = normalizePaths(imagePaths, config.maxImages);
    const images = [];
    let totalBytes = 0;
    for (const requestedPath of paths) {
        const resolved = fileSystem.resolveExisting(requestedPath, { type: 'file' });
        const stat = fs.statSync(resolved);
        if (stat.size <= 0) throw new Error(`Image is empty: ${requestedPath}`);
        if (stat.size > config.maxImageBytes) {
            throw new Error(`Image exceeds ${config.maxImageBytes} bytes: ${requestedPath}`);
        }
        totalBytes += stat.size;
        if (totalBytes > config.maxTotalImageBytes) {
            throw new Error(`Images exceed the ${config.maxTotalImageBytes} byte total limit`);
        }
        const buffer = fs.readFileSync(resolved);
        const mimeType = detectMimeType(buffer);
        if (!mimeType) {
            throw new Error(`Unsupported image content: ${requestedPath}; use PNG, JPEG, WebP, or GIF`);
        }
        const dimensions = imageDimensions(buffer, mimeType);
        images.push({
            path: fileSystem.relative(resolved),
            mimeType,
            bytes: buffer.length,
            sha256: crypto.createHash('sha256').update(buffer).digest('hex'),
            width: dimensions?.width || null,
            height: dimensions?.height || null,
            dataUrl: `data:${mimeType};base64,${buffer.toString('base64')}`,
        });
    }
    return images;
}

function publicImageMetadata(image) {
    return {
        path: image.path,
        mimeType: image.mimeType,
        bytes: image.bytes,
        sha256: image.sha256,
        width: image.width,
        height: image.height,
    };
}

module.exports = {
    detectMimeType,
    imageDimensions,
    normalizePaths,
    loadImages,
    publicImageMetadata,
};
