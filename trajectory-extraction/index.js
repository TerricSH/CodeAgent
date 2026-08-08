const { SCHEMA_VERSION, TrajectoryExtractor } = require('./extractor');
const { extractMessageSpans } = require('./message-spans');
const { compareTrajectories } = require('./comparison');
const { AuditTrajectorySource, buildSpanTree } = require('./audit-source');

module.exports = {
    SCHEMA_VERSION,
    TrajectoryExtractor,
    extractMessageSpans,
    compareTrajectories,
    AuditTrajectorySource,
    buildSpanTree,
};
