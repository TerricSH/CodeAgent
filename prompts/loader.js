const fs = require('node:fs');
const path = require('node:path');

function loadPrompt(filePath) {
    const resolved = path.resolve(filePath);
    const stat = fs.statSync(resolved);
    if (!stat.isFile()) throw new Error(`Prompt path is not a file: ${resolved}`);
    return fs.readFileSync(resolved, 'utf8').trim();
}

function renderPrompt(template, values = {}) {
    if (typeof template !== 'string') throw new TypeError('Prompt template must be a string');
    let rendered = template.replace(
        /{{#([a-zA-Z0-9_.-]+)}}([\s\S]*?){{\/\1}}/g,
        (match, key, content) => values[key] ? content : ''
    );
    const malformedConditional = rendered.match(/{{[#/][a-zA-Z0-9_.-]+}}/);
    if (malformedConditional) {
        throw new Error(`Unresolved prompt template token: ${malformedConditional[0]}`);
    }
    const variables = [...rendered.matchAll(/{{([a-zA-Z0-9_.-]+)}}/g)];
    for (const match of variables) {
        if (!Object.prototype.hasOwnProperty.call(values, match[1])) {
            throw new Error(`Prompt template value is missing: ${match[1]}`);
        }
    }
    rendered = rendered.replace(/{{([a-zA-Z0-9_.-]+)}}/g, (match, key) => {
        const value = values[key];
        return value == null ? '' : String(value);
    });
    return rendered.trim();
}

function loadPromptTemplate(filePath) {
    const template = loadPrompt(filePath);
    return (values = {}) => renderPrompt(template, values);
}

module.exports = { loadPrompt, renderPrompt, loadPromptTemplate };
