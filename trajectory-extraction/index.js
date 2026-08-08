const { SCHEMA_VERSION, TrajectoryExtractor } = require('./extractor');
const { extractMessageSpans } = require('./message-spans');
const { compareTrajectories } = require('./comparison');

module.exports = {
    SCHEMA_VERSION,
    TrajectoryExtractor,
    extractMessageSpans,
    compareTrajectories,
};
