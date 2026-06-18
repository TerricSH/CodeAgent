const fs = require('fs');
const path = require('path');

function parseEnvLabels(raw) {
  if (!raw) return {};
  try {
    const obj = JSON.parse(raw);
    if (obj && typeof obj === 'object' && !Array.isArray(obj)) return obj;
    return {};
  } catch {
    return {};
  }
}

function loadLabelsFromFile() {
  const configPath = path.join(__dirname, 'labels.json');
  try {
    const raw = fs.readFileSync(configPath, 'utf-8');
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed;
    return {};
  } catch {
    return {};
  }
}

function createLabels(overrides = {}) {
  return { ...overrides };
}

const fileLabels = loadLabelsFromFile();
const envOverrides = parseEnvLabels(process.env.UI_LABELS);
const labels = createLabels({ ...fileLabels, ...envOverrides });

module.exports = { labels, createLabels };
