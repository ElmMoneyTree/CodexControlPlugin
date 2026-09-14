import { spawn } from 'node:child_process';

export async function resumeWithCodexCli(threadId, text, { spawnProcess = spawn } = {}) {
  const prompt = typeof text === 'string' ? text.trim() : '';
  if (!prompt) throw new Error('Cannot send an empty message');
  if (!/^[0-9a-f-]{16,}$/i.test(threadId)) throw new Error('Cannot resume a task with an invalid id');

  let child;
  try {
    child = spawnProcess('codex', ['exec', 'resume', threadId, '-', '--json'], {
      detached: true,
      stdio: ['pipe', 'ignore', 'ignore'],
      windowsHide: true,
    });
  } catch (error) {
    throw cliStartError(error);
  }

  await new Promise((resolve, reject) => {
    const onError = error => { cleanup(); reject(cliStartError(error)); };
    const onSpawn = () => { cleanup(); resolve(); };
    const cleanup = () => {
      child.off('error', onError);
      child.off('spawn', onSpawn);
    };
    child.once('error', onError);
    child.once('spawn', onSpawn);
  });

  child.stdin?.on('error', () => { /* The child reports failures through its own task state. */ });
  child.stdin?.end(`${prompt}\n`);
  child.unref();
  return { submitted: true, transport: 'codex-cli-resume', pid: child.pid ?? null };
}

function cliStartError(error) {
  const detail = error instanceof Error ? error.message : String(error);
  return new Error(`Old task is not loaded and Codex CLI resume could not start: ${detail}`);
}
