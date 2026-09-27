import { exportGallery } from './lib/export-gallery.js';

try {
  const { destination, count } = await exportGallery();
  console.log(`Exported ${count} artworks to ${destination}`);
  console.log(`Open ${destination}/index.html in a browser. Keep the entire folder together.`);
} catch (error) {
  console.error(`Export failed: ${error.message}`);
  process.exitCode = 1;
}
