import { execFileSync } from 'node:child_process';
import { config } from './config.js';

// Find node processes listening on the configured port. Uses lsof (macOS/Linux).
function listeners(port) {
  try {
    const out = execFileSync('lsof', ['-nP', `-iTCP:${port}`, '-sTCP:LISTEN', '-Fpc'], { encoding: 'utf8' });
    const procs = [];
    for (const line of out.split('\n')) {
      if (line.startsWith('p')) procs.push({ pid: Number(line.slice(1)) });
      else if (line.startsWith('c') && procs.length) procs.at(-1).command = line.slice(1);
    }
    return procs;
  } catch {
    return []; // lsof exits non-zero when nothing matches
  }
}

function alive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

const port = config.port;
const found = listeners(port);
const targets = found.filter((p) => p.command === 'node');

for (const other of found.filter((p) => p.command !== 'node')) {
  console.log(`Port ${port} is held by ${other.command} (PID ${other.pid}), not node. Leaving it alone.`);
}
if (!targets.length) {
  console.log(`No node server listening on port ${port}.`);
  process.exit(0);
}

for (const { pid } of targets) {
  process.kill(pid, 'SIGTERM');
  console.log(`Sent SIGTERM to node PID ${pid} on port ${port}.`);
}

// Give servers a few seconds to shut down cleanly before forcing it.
const deadline = Date.now() + 5000;
while (targets.some((t) => alive(t.pid)) && Date.now() < deadline) {
  await new Promise((resolve) => setTimeout(resolve, 200));
}
for (const { pid } of targets.filter((t) => alive(t.pid))) {
  process.kill(pid, 'SIGKILL');
  console.log(`PID ${pid} did not exit; sent SIGKILL.`);
}
console.log(`Port ${port} is free.`);
