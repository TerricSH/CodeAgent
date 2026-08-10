const researcher = require('./researcher');
const coder = require('./coder');
const tester = require('./tester');
const coverageVerifier = require('./coverage-verifier');

const agents = [researcher, coder, tester, coverageVerifier];

const registry = {};
for (const a of agents) {
    registry[a.name] = a;
}

function list() {
    return agents.map(a => ({ name: a.name, description: a.description }));
}

function get(name) {
    return registry[name] || null;
}

function listDescription() {
    return agents.map(a => `- ${a.name}: ${a.description}`).join('\n');
}

module.exports = { list, get, listDescription };
