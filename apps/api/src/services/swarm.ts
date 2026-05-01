import { spawn } from 'child_process';
import { config } from '../config';

export interface SwarmRunResult {
  ok: boolean;
  code: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
}

export function runSwarmExtraction(runId: string, text: string, documentName = 'input'): Promise<SwarmRunResult> {
  return new Promise((resolve, reject) => {
    const stubMode = process.env.ORCHESTRATOR_STUB_MODE === 'true';
    if (!stubMode && !process.env.ANTHROPIC_API_KEY) {
      reject(new Error('ANTHROPIC_API_KEY is required for specialist swarm extraction'));
      return;
    }

    const child = spawn('node', ['dist/index.js', '--', '--run-id', runId, '--document-name', documentName, '--stdin'], {
      cwd: config.swarmOrchestratorCwd,
      env: {
        ...process.env,
        API_BASE_URL: `http://localhost:${config.port}`,
        STUB_MODE: stubMode ? 'true' : 'false',
      },
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    let stdout = '';
    let stderr = '';
    let settled = false;

    const timeout = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill('SIGTERM');
      reject(new Error(`Swarm extraction timed out after ${config.swarmTimeoutMs}ms`));
    }, config.swarmTimeoutMs);

    child.stdout.on('data', chunk => {
      stdout += chunk.toString();
    });

    child.stderr.on('data', chunk => {
      stderr += chunk.toString();
    });

    child.on('error', err => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      reject(err);
    });

    child.on('close', (code, signal) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      resolve({ ok: code === 0, code, signal, stdout, stderr });
    });

    child.stdin.end(text);
  });
}
