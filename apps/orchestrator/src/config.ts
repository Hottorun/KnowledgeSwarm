import dotenv from 'dotenv';
import path from 'path';

dotenv.config({ path: path.resolve(__dirname, '../.env') });

export const config = {
  anthropicApiKey: process.env.ANTHROPIC_API_KEY || (process.env.STUB_MODE === 'true' ? 'sk-ant-stub-00000' : ''),
  apiBaseUrl: process.env.API_BASE_URL || 'http://localhost:8787',
  stubMode: process.env.STUB_MODE === 'true',
  metaModel: 'claude-sonnet-4-6' as const,
  supervisorModel: 'claude-haiku-4-5-20251001' as const,
  workerModel: 'claude-haiku-4-5-20251001' as const,
  expanderModel: 'claude-haiku-4-5-20251001' as const,
  chunkWords: 600,
  chunkOverlapWords: 80,
  metaSummaryChars: 2000,
};
