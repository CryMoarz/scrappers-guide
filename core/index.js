// Node entry point for the shared core. The browser build inlines the same files in this order.
if (!globalThis.crypto || !globalThis.crypto.subtle) globalThis.crypto = require('crypto').webcrypto;

const MODULES = ['util', 'schema', 'db', 'specs', 'search', 'text', 'sign', 'changes', 'votes'];
const SDG = {};
MODULES.forEach(n => require('./' + n)(SDG));
SDG.schema.use(require('../schema/sdg.schema.json'));
SDG.MODULES = MODULES;

module.exports = SDG;
