import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import Database from 'better-sqlite3';

export const dataDir = path.resolve(process.env.AGENT_DATA_DIR || path.join(os.homedir(), '.agent-art-world', 'data'));
export const exportsDir = path.resolve(process.env.AGENT_EXPORT_DIR || path.join(os.homedir(), '.agent-art-world', 'exports'));
export const legacyDataDir = path.resolve('data');

function isEmptyExperiment(dbFile) {
  if (!fs.existsSync(dbFile)) return true;
  const current = new Database(dbFile, { readonly: true, fileMustExist: true });
  try {
    const actions = current.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'actions'").get();
    const objects = current.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'objects'").get();
    return (!actions || !current.prepare('SELECT 1 FROM actions LIMIT 1').get()) &&
      (!objects || !current.prepare("SELECT 1 FROM objects WHERE type != 'world' LIMIT 1").get());
  } finally { current.close(); }
}

export async function migrateData(sourceDir, destinationDir = dataDir) {
  const source = path.resolve(sourceDir);
  const destination = path.resolve(destinationDir);
  if (source === destination) throw new Error('Source and destination data folders are identical.');
  const sourceDb = path.join(source, 'world.sqlite');
  if (!fs.existsSync(sourceDb)) throw new Error(`No world.sqlite found in ${source}.`);
  if (isEmptyExperiment(sourceDb)) throw new Error(`No actions or artworks found in ${source}. Choose the earlier data folder that contains your work.`);
  fs.mkdirSync(destination, { recursive: true });
  const targetDb = path.join(destination, 'world.sqlite');
  if (!isEmptyExperiment(targetDb)) throw new Error(`Destination already contains an experiment: ${targetDb}. No files were changed.`);
  const targetImages = path.join(destination, 'images');
  if (fs.existsSync(targetImages) && fs.readdirSync(targetImages).length) {
    throw new Error(`Destination images folder is not empty: ${targetImages}. No files were changed.`);
  }
  const staging = fs.mkdtempSync(path.join(destination, '.import-'));
  try {
    const old = new Database(sourceDb, { readonly: true, fileMustExist: true });
    try { await old.backup(path.join(staging, 'world.sqlite')); } finally { old.close(); }
    const sourceImages = path.join(source, 'images');
    if (fs.existsSync(sourceImages)) fs.cpSync(sourceImages, path.join(staging, 'images'), { recursive: true });
    // Preserve any empty starting database, including its journal sidecars.
    for (const name of ['world.sqlite', 'world.sqlite-wal', 'world.sqlite-shm']) {
      const file = path.join(destination, name);
      if (fs.existsSync(file)) fs.renameSync(file, path.join(staging, `previous-${name}`));
    }
    fs.renameSync(path.join(staging, 'world.sqlite'), targetDb);
    if (fs.existsSync(path.join(staging, 'images'))) {
      if (fs.existsSync(targetImages)) fs.rmdirSync(targetImages);
      fs.renameSync(path.join(staging, 'images'), targetImages);
    }
    const previous = fs.readdirSync(staging).filter(name => name.startsWith('previous-'));
    if (previous.length) {
      const backupDir = path.join(destination, `previous-empty-world-${randomUUID().slice(0, 8)}`);
      fs.mkdirSync(backupDir);
      for (const name of previous) fs.renameSync(path.join(staging, name), path.join(backupDir, name));
    }
    return { source, destination };
  } finally { fs.rmSync(staging, { recursive: true, force: true }); }
}

export async function prepareStorage() {
  fs.mkdirSync(dataDir, { recursive: true });
  const marker = path.join(dataDir, '.initialized');
  if (!fs.existsSync(marker) && !fs.existsSync(path.join(dataDir, 'world.sqlite')) && fs.existsSync(path.join(legacyDataDir, 'world.sqlite')) && !isEmptyExperiment(path.join(legacyDataDir, 'world.sqlite')) && dataDir !== legacyDataDir) {
    await migrateData(legacyDataDir, dataDir);
    fs.writeFileSync(marker, 'Agent Art World data directory\n');
    return { migratedFrom: legacyDataDir };
  }
  if (!fs.existsSync(marker)) fs.writeFileSync(marker, 'Agent Art World data directory\n');
  return { migratedFrom: null };
}
