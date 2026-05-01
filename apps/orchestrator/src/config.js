"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.config = void 0;
const dotenv_1 = __importDefault(require("dotenv"));
const path_1 = __importDefault(require("path"));
dotenv_1.default.config({ path: path_1.default.resolve(__dirname, '../.env') });
exports.config = {
    anthropicApiKey: process.env.ANTHROPIC_API_KEY || (process.env.STUB_MODE === 'true' ? 'sk-ant-stub-00000' : ''),
    apiBaseUrl: process.env.API_BASE_URL || 'http://localhost:8787',
    stubMode: process.env.STUB_MODE === 'true',
    metaModel: 'claude-sonnet-4-6',
    supervisorModel: 'claude-haiku-4-5-20251001',
    workerModel: 'claude-haiku-4-5-20251001',
    expanderModel: 'claude-haiku-4-5-20251001',
    chunkWords: 600,
    chunkOverlapWords: 80,
    metaSummaryChars: 2000,
};
//# sourceMappingURL=config.js.map