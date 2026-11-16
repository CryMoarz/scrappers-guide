// What a model record says when it is in the data but not yet fact-checked: research drafts landed
// early (tools/research.js land) and datasets imported in bulk (tools/import-openwrt.js). Its
// parts show as likely; a fact-check replaces it with a checked, documented version.
const LANDED = 'Not yet fact-checked: its parts show as likely until a fact-check confirms them against their sources.';
const isLanded = m => !!(m && m.research && (m.research.method || []).includes(LANDED));
module.exports = { LANDED, isLanded };
