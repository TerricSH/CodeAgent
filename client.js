const ModelClient = require('./model');
require('dotenv').config();

const client = new ModelClient({
    apiKey: process.env.API_KEY,
    baseURL: process.env.API_BASE_URL,
    model: process.env.MODEL_NAME || 'mimo-v2.5-pro',
});

module.exports = client;
