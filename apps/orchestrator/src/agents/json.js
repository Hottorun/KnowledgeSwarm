"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.parseJsonObject = parseJsonObject;
function parseJsonObject(text) {
    const trimmed = text.trim();
    try {
        return JSON.parse(trimmed);
    }
    catch {
        const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i);
        if (fenced?.[1]) {
            return JSON.parse(fenced[1].trim());
        }
        const first = trimmed.indexOf('{');
        const last = trimmed.lastIndexOf('}');
        if (first !== -1 && last > first) {
            return JSON.parse(trimmed.slice(first, last + 1));
        }
        throw new Error(`No JSON object found in model output: ${trimmed.slice(0, 300)}`);
    }
}
//# sourceMappingURL=json.js.map