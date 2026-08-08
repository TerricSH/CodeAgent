const fs = require('node:fs');
const path = require('node:path');

function loadRegistry() {
    const registry = new Map();
    const directories = fs.readdirSync(__dirname, { withFileTypes: true })
        .filter(entry => entry.isDirectory())
        .sort((left, right) => left.name.localeCompare(right.name));
    for (const directory of directories) {
        const indexPath = path.join(__dirname, directory.name, 'index.js');
        if (!fs.existsSync(indexPath)) continue;
        const resolved = require.resolve(indexPath);
        delete require.cache[resolved];
        const skill = require(resolved);
        if (!skill || typeof skill.name !== 'string' || typeof skill.prompt !== 'string') {
            throw new Error(`Invalid Skill module: ${indexPath}`);
        }
        if (registry.has(skill.name)) throw new Error(`Duplicate Skill name: ${skill.name}`);
        registry.set(skill.name, skill);
    }
    return registry;
}

function all() {
    return [...loadRegistry().values()];
}

function list() {
    return all().map(skill => ({ name: skill.name, description: skill.description }));
}

function get(name) {
    return loadRegistry().get(name) || null;
}

function listDescription() {
    return all().map(skill => `- ${skill.name}: ${skill.description}`).join('\n');
}

module.exports = { list, get, listDescription, all };
