"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.search = search;
const config_1 = require("../config");
const fixtures_1 = require("../stubs/fixtures");
async function search(query) {
    if (config_1.config.stubMode) {
        console.log(`  [search] stub: "${query}"`);
        return fixtures_1.STUB_SEARCH_RESULTS;
    }
    const res = await fetch(`${config_1.config.apiBaseUrl}/search`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ query }),
    });
    if (!res.ok) {
        console.error(`[search] failed: ${res.status}`);
        return [];
    }
    const data = (await res.json());
    return data.results ?? [];
}
//# sourceMappingURL=search.js.map