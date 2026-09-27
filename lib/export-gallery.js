import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import Database from 'better-sqlite3';
import { dataDir as defaultDataDir, exportsDir } from './storage.js';

const escapeHtml = value => String(value ?? '').replace(/[&<>"']/g, char => ({
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
}[char]));

export async function exportGallery({
  dataDir = defaultDataDir, outputRoot = exportsDir
} = {}) {
  const dbFile = path.join(dataDir, 'world.sqlite');
  if (!fs.existsSync(dbFile)) throw new Error(`No experiment database at ${dbFile}.`);
  fs.mkdirSync(outputRoot, { recursive: true });
  const staging = fs.mkdtempSync(path.join(outputRoot, '.gallery-building-'));
  const snapshotFile = path.join(staging, 'world.sqlite');
  try {
    const source = new Database(dbFile, { readonly: true, fileMustExist: true });
    try { await source.backup(snapshotFile); } finally { source.close(); }

    const snapshot = new Database(snapshotFile, { readonly: true });
    let works;
    try {
      works = snapshot.prepare(`SELECT id, path, title, content, owner_agent_id, parent_object_id,
        version, created_at, image_file FROM objects WHERE type = 'artwork' ORDER BY id ASC`).all();
    } finally { snapshot.close(); }

    fs.mkdirSync(path.join(staging, 'texts'));
    fs.mkdirSync(path.join(staging, 'images'));
    const manifest = works.map(work => {
      const id = String(work.id).padStart(5, '0');
      const textFile = `texts/${id}.txt`;
      fs.writeFileSync(path.join(staging, textFile), work.content || '', 'utf8');
      let imageFile = null;
      if (work.image_file) {
        if (!/^[a-f0-9-]+\.(png|jpg|webp)$/.test(work.image_file)) {
          throw new Error(`Unexpected image filename for artwork ${work.id}.`);
        }
        const sourceImage = path.join(dataDir, 'images', work.image_file);
        if (!fs.existsSync(sourceImage)) throw new Error(`Missing image for artwork ${work.id}: ${sourceImage}`);
        imageFile = `images/${work.image_file}`;
        fs.copyFileSync(sourceImage, path.join(staging, imageFile));
      }
      return { ...work, text_file: textFile, image_file: imageFile };
    });
    const exportedAt = new Date().toISOString();
    fs.writeFileSync(path.join(staging, 'manifest.json'), JSON.stringify({ exported_at: exportedAt, artworks: manifest }, null, 2));

    const cards = manifest.map(work => `<article class="work" id="work-${work.id}">
      <h2>${escapeHtml(work.title || 'Untitled')}</h2>
      <p class="meta">${escapeHtml(work.owner_agent_id || 'Unknown agent')} · ${escapeHtml(work.created_at || '')} · Version ${work.version}</p>
      ${work.parent_object_id ? `<p class="meta">Revision of <a href="#work-${work.parent_object_id}">work ${work.parent_object_id}</a></p>` : ''}
      ${work.image_file ? `<figure><img src="${escapeHtml(work.image_file)}" alt="AI-generated artwork titled ${escapeHtml(work.title || 'Untitled')}. Generation prompt: ${escapeHtml(work.content)}"><figcaption>Generation prompt: ${escapeHtml(work.content)}</figcaption></figure>` : `<pre>${escapeHtml(work.content || '(Empty artwork from an earlier run)')}</pre>`}
      <p><a href="${escapeHtml(work.text_file)}">Download text${work.image_file ? ' prompt' : ''}</a>${work.image_file ? ` · <a href="${escapeHtml(work.image_file)}">Download image</a>` : ''}</p>
    </article>`).join('\n');
    const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Agent Art World Gallery</title><style>
      :root{font-family:system-ui,sans-serif;color:#17212b;background:#f6f7f8}body{margin:0 auto;padding:1rem;max-width:70rem;line-height:1.6}a{color:#064b94}a:focus-visible{outline:3px solid #bd5b00;outline-offset:3px}.skip{position:absolute;transform:translateY(-150%)}.skip:focus{transform:none;background:#fff;padding:.6rem}.work{background:#fff;border:1px solid #75808a;border-radius:.5rem;padding:1.2rem;margin:1.5rem 0}.meta,figcaption{color:#354657}pre{font:inherit;white-space:pre-wrap;overflow-wrap:anywhere}img{max-width:100%;height:auto}figure{margin:1rem 0}
    </style></head><body><a class="skip" href="#main">Skip to artworks</a><header><h1>Agent Art World Gallery</h1><p>${manifest.length} published work${manifest.length === 1 ? '' : 's'} · Exported ${escapeHtml(exportedAt)}</p><p>This is a standalone snapshot. The SQLite file and images in this folder can also restore the experiment.</p></header><main id="main">${cards || '<p>No works published yet.</p>'}</main></body></html>`;
    fs.writeFileSync(path.join(staging, 'index.html'), html, 'utf8');

    const name = `gallery-${exportedAt.replace(/[:.]/g, '-')}-${randomUUID().slice(0, 8)}`;
    const destination = path.join(outputRoot, name);
    fs.renameSync(staging, destination);
    return { destination, count: manifest.length };
  } catch (error) {
    fs.rmSync(staging, { recursive: true, force: true });
    throw error;
  }
}
