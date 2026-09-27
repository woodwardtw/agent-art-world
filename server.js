import express from 'express';
import fs from 'node:fs';
import path from 'node:path';
import { config } from './config.js';
import { storageState } from './lib/db.js';
import { dataDir } from './lib/storage.js';
import { listOllamaModels } from './lib/ollama.js';
import { generateImage } from './lib/mflux.js';
import { critiqueRandomWork, surveyWorks } from './lib/critic.js';
import { nextAgentId, reviewDueOrientation, runAgentTurn } from './lib/runner.js';
import {
  addView,
  getAgents,
  getEngagement,
  getAction,
  getActionsPage,
  getArtworksPage,
  getConfidenceHistory,
  getImageActivity,
  getObjectByPath,
  getOrientationReviews,
  getOrientationReviewStatus,
  getObjectsPage,
  getStats,
  getUnderstandingsPage,
  setAgentModel,
  setAgentCapabilities
} from './lib/world.js';

const app = express();
app.use(express.json({ limit: '2mb' }));
app.use(express.static('public'));

app.get('/api/status', async (req, res) => {
  let ollama = { ok: false, models: [], error: null };
  try {
    ollama.models = await listOllamaModels();
    ollama.ok = true;
  } catch (error) {
    ollama.error = error.message;
  }

  res.json({
    charge: config.charge,
    dataDir,
    databasePath: path.join(dataDir, 'world.sqlite'),
    migratedFrom: storageState.migratedFrom,
    defaultModel: config.defaultModel,
    captureThinking: config.captureThinking,
    agentVisibleObjects: config.maxAgentVisibleObjects,
    agentIncludeReflections: config.agentIncludeReflections,
    imageModel: config.imageModel,
    visionModel: config.visionModel,
    criticProbability: config.criticProbability,
    criticSurveyEvery: config.criticSurveyEvery,
    imageActivity: getImageActivity(),
    ollama,
    stats: getStats()
  });
});

app.get('/api/agents', (req, res) => res.json(getAgents().map(agent => ({
  ...agent,
  orientation_reviews: getOrientationReviews(agent.id, 10),
  orientation_review_status: getOrientationReviewStatus(agent.id),
  confidence_history: getConfidenceHistory(agent.id, 10)
}))));
app.post('/api/agents/:id/orientation-review', async (req, res) => {
  try {
    const result = await reviewDueOrientation(req.params.id);
    if (!result) return res.status(409).json({ error: 'No overdue orientation review.' });
    res.json(result);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});
app.get('/api/actions', (req, res) => res.json(getActionsPage(req.query.page, req.query.pageSize)));
app.get('/api/understandings', (req, res) => res.json(getUnderstandingsPage(req.query.page, req.query.pageSize)));
app.get('/api/actions/:id', (req, res) => {
  const action = getAction(Number(req.params.id));
  if (!action) return res.status(404).json({ error: 'Action not found' });
  res.json(action);
});
app.get('/api/objects', (req, res) => res.json(getObjectsPage(req.query.page, req.query.pageSize)));
app.get('/api/artworks', (req, res) => res.json(getArtworksPage(req.query.page, req.query.pageSize)));

app.get('/api/object', (req, res) => {
  const object = getObjectByPath(String(req.query.path || ''));
  if (!object) return res.status(404).json({ error: 'Not found' });
  res.json(object);
});

// Opening a work in the dashboard counts as an observer view; agents see these counts.
app.post('/api/objects/:id/view', (req, res) => {
  const id = Number(req.params.id);
  if (!addView(id)) return res.status(404).json({ error: 'Artwork not found' });
  res.json(getEngagement(id));
});

app.get('/api/objects/:id/image', (req, res) => {
  const object = getObjectByPath(String(req.query.path || ''));
  if (!object || object.id !== Number(req.params.id) || !/^[a-f0-9-]+\.(png|jpg|webp)$/.test(object.image_file || '')) {
    return res.status(404).end();
  }
  const file = path.join(dataDir, 'images', object.image_file);
  if (!fs.existsSync(file)) return res.status(404).end();
  // The default data dir is ~/.agent-art-world, and send refuses dot-directory paths unless allowed.
  res.type(path.extname(file)).sendFile(file, { dotfiles: 'allow' });
});

app.post('/api/agents/:id/model', (req, res) => {
  const model = String(req.body?.model || '').trim();
  if (!model) return res.status(400).json({ error: 'model is required' });
  if (!getAgents().some(agent => agent.id === req.params.id)) return res.status(404).json({ error: 'Agent not found' });
  setAgentModel(req.params.id, model);
  res.json({ ok: true });
});

app.post('/api/agents/:id/capabilities', (req, res) => {
  try {
    setAgentCapabilities(req.params.id, req.body?.capabilities);
    res.json({ ok: true });
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

app.post('/api/step', async (req, res) => {
  try {
    const agentId = req.body?.agentId || nextAgentId();
    const result = await runAgentTurn(agentId);
    res.json(result);
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: error.message });
  }
});

app.post('/api/critic/critique', async (req, res) => {
  try {
    const result = await critiqueRandomWork();
    if (!result) return res.status(409).json({ error: 'There are no artworks to critique yet.' });
    res.json(result);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.post('/api/critic/survey', async (req, res) => {
  try {
    const result = await surveyWorks();
    if (!result) return res.status(409).json({ error: 'There are no artworks to survey yet.' });
    res.json(result);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.post('/api/image-test', async (req, res) => {
  try {
    const result = await generateImage('A blue paper crane on a plain white background');
    res.type('png').send(result.bytes);
  } catch (error) {
    res.status(502).json({ error: error.message });
  }
});

app.listen(config.port, config.host, () => {
  console.log(`Agent Art World: http://${config.host}:${config.port}`);
  console.log(`Ollama: ${config.ollamaBaseUrl}`);
  console.log(`Default model: ${config.defaultModel}`);
  console.log(`Data: ${dataDir}`);
  if (storageState.migratedFrom) console.log(`Migrated legacy data from ${storageState.migratedFrom}`);
});
