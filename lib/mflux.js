import { execFile } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { config } from '../config.js';

// One image at a time: each mflux run loads the full model into unified memory.
let queue = Promise.resolve();

export function generateImage(prompt) {
  const run = queue.then(() => runMflux(prompt));
  queue = run.catch(() => {});
  return run;
}

async function runMflux(prompt) {
  const output = path.join(os.tmpdir(), `agent-art-${randomUUID()}.png`);
  const args = ['--prompt', prompt, '--steps', String(config.mflux.steps),
    '--width', String(config.mflux.width), '--height', String(config.mflux.height),
    '--output', output, '--no-metadata'];
  if (config.mflux.quantize) args.push('--quantize', String(config.mflux.quantize));
  try {
    await new Promise((resolve, reject) => {
      execFile(config.mflux.command, args, { timeout: config.mflux.timeoutMs, maxBuffer: 16 * 1024 * 1024 },
        (error, stdout, stderr) => {
          if (!error) return resolve();
          if (error.code === 'ENOENT') {
            return reject(new Error(`Image generation unavailable: mflux command not found (${config.mflux.command}). Install with "pipx install mflux" or set MFLUX_COMMAND.`));
          }
          const detail = error.killed ? `timed out after ${config.mflux.timeoutMs} ms` : String(stderr || stdout || error.message).trim().slice(-400);
          reject(new Error(`Image generation failed (mflux): ${detail}`));
        });
    });
    if (!fs.existsSync(output)) throw new Error('mflux finished but wrote no image.');
    const bytes = fs.readFileSync(output);
    if (bytes.length > config.maxImageBytes) throw new Error('Image exceeded size limit.');
    if (!bytes.subarray(0, 8).equals(Buffer.from('89504e470d0a1a0a', 'hex'))) throw new Error('mflux returned unsupported image bytes.');
    return { bytes, extension: 'png' };
  } finally {
    fs.rmSync(output, { force: true });
  }
}
