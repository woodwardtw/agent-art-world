import fs from 'node:fs';
import path from 'node:path';
import { dataDir } from './lib/storage.js';

const file = path.join(dataDir, 'world.sqlite');
const wal = `${file}-wal`;
const shm = `${file}-shm`;
for (const target of [file, wal, shm]) {
  if (fs.existsSync(target)) fs.rmSync(target);
}
fs.rmSync(path.join(dataDir, 'images'), { recursive: true, force: true });
console.log('World database and generated images removed. They will be recreated on next start.');
