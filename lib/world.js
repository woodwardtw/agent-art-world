import { db } from './db.js';
import { config } from '../config.js';

function clip(value, max = 500) {
  const text = String(value ?? '');
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

export function getAgent(id) {
  return db.prepare('SELECT * FROM agents WHERE id = ?').get(id);
}

export function getRecentAgentActions(agentId, limit = 5, offset = 0) {
  return db.prepare(`
    SELECT id, action_type, target_path, summary, created_at
    FROM actions WHERE agent_id = ? ORDER BY id DESC LIMIT ? OFFSET ?
  `).all(agentId, Math.min(20, Math.max(1, Number(limit) || 5)), Math.max(0, Number(offset) || 0));
}

export function getRecentAgentArtworks(agentId, limit = 5) {
  return db.prepare(`
    SELECT path, title, content, image_file, version, created_at
    FROM objects WHERE owner_agent_id = ? AND type = 'artwork'
    ORDER BY id DESC LIMIT ?
  `).all(agentId, Math.min(10, Math.max(1, Number(limit) || 5)));
}

export function getOrientationReviews(agentId, limit = 5) {
  return db.prepare(`
    SELECT id, action_id, reviewed_turn_count, previous_orientation, current_orientation,
      confidence, rationale, outcome, prompt_tokens, completion_tokens, created_at
    FROM orientation_reviews WHERE agent_id = ? ORDER BY id DESC LIMIT ?
  `).all(agentId, Math.min(50, Math.max(1, Number(limit) || 5)));
}

export function getOrientationReviewStatus(agentId) {
  const agent = getAgent(agentId);
  if (!agent) return null;
  const lastReview = db.prepare(`
    SELECT MAX(reviewed_turn_count) AS reviewed_turn_count
    FROM orientation_reviews WHERE agent_id = ?
  `).get(agentId)?.reviewed_turn_count || 0;
  const checkpoint = Math.floor(Number(agent.action_count) / 5) * 5;
  return {
    turns: Number(agent.action_count),
    checkpoint,
    lastReviewedTurn: Number(lastReview),
    due: checkpoint > Number(lastReview)
  };
}

export function isConfidence(value) {
  return Number.isInteger(value) && value >= 1 && value <= 10;
}

// Other agents' actions on this agent's work after `sinceActionId`: reads, image inspections,
// and revisions descended from its artworks, with the responder's learning entry when present.
export function getResponsesToWork(agentId, sinceActionId = 0, limit = 12) {
  return db.prepare(`
    SELECT actions.id, actions.agent_id, actions.action_type, actions.target_path, actions.summary,
      understandings.content AS learning
    FROM actions
    LEFT JOIN understandings ON understandings.action_id = actions.id
    WHERE actions.id > ? AND actions.agent_id != ? AND (
      actions.target_path IN (SELECT path FROM objects WHERE owner_agent_id = ?)
      OR actions.target_path IN (
        SELECT child.path FROM objects child JOIN objects parent ON child.parent_object_id = parent.id
        WHERE parent.owner_agent_id = ? AND child.owner_agent_id != ?)
    )
    ORDER BY actions.id DESC LIMIT ?
  `).all(Number(sinceActionId) || 0, agentId, agentId, agentId, agentId, limit).reverse();
}

export function saveTurnConfidence(agentId, actionId, confidence, reason) {
  if (!isConfidence(confidence)) return null;
  const text = clip(String(reason || '').trim(), 600) || null;
  db.transaction(() => {
    db.prepare('UPDATE actions SET confidence = ?, confidence_reason = ? WHERE id = ?').run(confidence, text, actionId);
    db.prepare('UPDATE agents SET confidence = ? WHERE id = ?').run(confidence, agentId);
  })();
  return confidence;
}

// Newest-first confidence ratings from turns and orientation reviews, each with the rating before it.
export function getConfidenceHistory(agentId, limit = 10) {
  const size = Math.min(50, Math.max(1, Number(limit) || 10));
  const rows = db.prepare(`
    SELECT * FROM (
      SELECT id AS action_id, 'turn' AS source, confidence, confidence_reason AS reason, created_at
      FROM actions WHERE agent_id = ? AND confidence IS NOT NULL
      UNION ALL
      SELECT action_id, 'review' AS source, confidence, rationale AS reason, created_at
      FROM orientation_reviews WHERE agent_id = ? AND confidence IS NOT NULL
    ) ORDER BY action_id DESC, source = 'review' DESC LIMIT ?
  `).all(agentId, agentId, size + 1);
  return rows.slice(0, size).map((row, index) => ({ ...row, previous: rows[index + 1]?.confidence ?? null }));
}

export function getAgents() {
  return db.prepare('SELECT * FROM agents ORDER BY id').all();
}

export const optionalCapabilities = ['image_generation', 'image_vision'];
export function setAgentCapabilities(id, capabilities) {
  if (!Array.isArray(capabilities) || capabilities.some(value => !optionalCapabilities.includes(value))) {
    throw new Error('Invalid capabilities.');
  }
  const result = db.prepare('UPDATE agents SET capabilities = ? WHERE id = ?')
    .run(JSON.stringify([...new Set(capabilities)]), id);
  if (!result.changes) throw new Error('Agent not found.');
}

export function getImageCount() {
  return db.prepare("SELECT COUNT(*) AS count FROM objects WHERE image_file IS NOT NULL").get().count;
}

export function getImageActivity() {
  const attempts = db.prepare("SELECT COUNT(*) AS count FROM actions WHERE action_type = 'generate_image'").get().count;
  const lastAttempt = db.prepare("SELECT agent_id, summary FROM actions WHERE action_type = 'generate_image' ORDER BY id DESC LIMIT 1").get() || null;
  return { attempts, created: getImageCount(), lastAttempt };
}

export function getArtworkPaths() {
  return db.prepare("SELECT path FROM objects WHERE type = 'artwork' ORDER BY id DESC LIMIT 30")
    .all().map(item => item.path);
}

export function createImageArtwork(agent, title, prompt, filename) {
  const info = db.prepare(`INSERT INTO objects (path, type, title, content, owner_agent_id, image_file)
    VALUES ('pending', 'artwork', ?, ?, ?, ?)`).run(title, prompt, agent.id, filename);
  const path = makeArtifactPath(info.lastInsertRowid, title);
  db.prepare('UPDATE objects SET path = ? WHERE id = ?').run(path, info.lastInsertRowid);
  addMemory(agent.id, 'action', `You generated an image artwork at ${path}.`);
  return { targetPath: path, summary: `Generated image “${title}”.` };
}

export function setAgentModel(id, model) {
  return db.prepare('UPDATE agents SET model = ? WHERE id = ?').run(model, id);
}

const engagementColumns = `
  (SELECT COUNT(*) FROM views WHERE views.object_id = objects.id) AS view_count,
  (SELECT COUNT(*) FROM views WHERE views.object_id = objects.id AND viewer_kind = 'observer') AS observer_view_count,
  (SELECT COUNT(*) FROM comments WHERE comments.object_id = objects.id) AS comment_count`;

export function getRecentObjects(limit = config.maxVisibleObjects) {
  return db.prepare(`
    SELECT id, path, type, title, owner_agent_id, version, image_file, created_at,
           substr(content, 1, 360) AS excerpt, ${engagementColumns}
    FROM objects
    ORDER BY id DESC
    LIMIT ?
  `).all(Math.min(100, Math.max(1, Number(limit) || 8)));
}

// Newest-first page of a query. A page past the end is clamped to the last page.
function pageOf(countSql, itemsSql, page, pageSize, defaultSize) {
  const safeSize = Math.min(100, Math.max(1, Math.floor(Number(pageSize) || defaultSize)));
  const total = db.prepare(countSql).get().count;
  const lastPage = Math.max(0, Math.ceil(total / safeSize) - 1);
  const safePage = Math.min(lastPage, Math.max(0, Math.floor(Number(page) || 0)));
  const items = db.prepare(`${itemsSql} LIMIT ? OFFSET ?`).all(safeSize, safePage * safeSize);
  return { items, page: safePage, pageSize: safeSize, total };
}

export function getArtworksPage(page = 0, pageSize = 24) {
  return pageOf("SELECT COUNT(*) AS count FROM objects WHERE type = 'artwork'",
    `SELECT id, path, type, title, owner_agent_id, version,
    parent_object_id, image_file, created_at, substr(content, 1, 360) AS excerpt, ${engagementColumns}
    FROM objects WHERE type = 'artwork' ORDER BY id DESC`, page, pageSize, 24);
}

export function getObjectsPage(page = 0, pageSize = 10) {
  return pageOf('SELECT COUNT(*) AS count FROM objects',
    `SELECT id, path, type, title, owner_agent_id, version, image_file, created_at,
    substr(content, 1, 360) AS excerpt, ${engagementColumns}
    FROM objects ORDER BY id DESC`, page, pageSize, 10);
}

export function getObjectByPath(path) {
  return db.prepare(`SELECT * FROM objects WHERE path = ? ORDER BY id DESC LIMIT 1`).get(path);
}

export function listObjects(prefix = '/') {
  const safePrefix = String(prefix || '/');
  return db.prepare(`
    SELECT id, path, type, title, owner_agent_id, version, image_file, created_at,
           substr(content, 1, 500) AS excerpt, ${engagementColumns}
    FROM objects
    WHERE path LIKE ?
    ORDER BY id DESC
    LIMIT 40
  `).all(`${safePrefix}%`);
}

export function addView(objectId, { agentId = null, actionId = null } = {}) {
  const object = db.prepare('SELECT id, type FROM objects WHERE id = ?').get(objectId);
  if (object?.type !== 'artwork') return false;
  const afterActionId = actionId ?? db.prepare('SELECT COALESCE(MAX(id), 0) AS id FROM actions').get().id;
  db.prepare('INSERT INTO views (object_id, viewer_kind, agent_id, action_id, after_action_id) VALUES (?, ?, ?, ?, ?)')
    .run(objectId, agentId ? 'agent' : 'observer', agentId, actionId, afterActionId);
  return true;
}

export function getEngagement(objectId, commentLimit = 50) {
  const counts = db.prepare(`
    SELECT COUNT(*) AS views,
      COALESCE(SUM(viewer_kind = 'agent'), 0) AS agent_views,
      COALESCE(SUM(viewer_kind = 'observer'), 0) AS observer_views
    FROM views WHERE object_id = ?`).get(objectId);
  const comments = db.prepare(`
    SELECT * FROM (SELECT id, agent_id, action_id, content, created_at FROM comments
      WHERE object_id = ? ORDER BY id DESC LIMIT ?) ORDER BY id`).all(objectId, commentLimit);
  const commentCount = db.prepare('SELECT COUNT(*) AS count FROM comments WHERE object_id = ?').get(objectId).count;
  return { ...counts, comment_count: commentCount, comments };
}

export function linkCommentToAction(commentId, actionId) {
  db.prepare('UPDATE comments SET action_id = ? WHERE id = ?').run(actionId, commentId);
}

// Observer views of this agent's works since its last turn, grouped by work.
export function getObserverViewsOfWork(agentId, sinceActionId = 0) {
  return db.prepare(`
    SELECT objects.path, COUNT(*) AS views FROM views
    JOIN objects ON objects.id = views.object_id
    WHERE objects.owner_agent_id = ? AND views.viewer_kind = 'observer' AND views.after_action_id >= ?
    GROUP BY objects.path ORDER BY views DESC LIMIT 12
  `).all(agentId, Number(sinceActionId) || 0);
}

function formatEngagement(object) {
  const engagement = getEngagement(object.id, 10);
  const comments = engagement.comments.map(item => `  [${item.agent_id}] ${clip(item.content, 400)}`).join('\n');
  return `\nViews: ${engagement.views} (${engagement.agent_views} by agents, ${engagement.observer_views} by outside observers). Comments: ${engagement.comment_count}${engagement.comment_count > engagement.comments.length ? ' (latest 10, oldest first)' : ''}${comments ? `\n${comments}` : ''}`;
}

export function getMemories(agentId) {
  return db.prepare(`
    SELECT kind, content, created_at
    FROM memories
    WHERE agent_id = ?
    ORDER BY id DESC
    LIMIT ?
  `).all(agentId, config.maxMemoryItems).reverse();
}

export function addMemory(agentId, kind, content) {
  db.prepare('INSERT INTO memories (agent_id, kind, content) VALUES (?, ?, ?)')
    .run(agentId, kind, clip(content, config.maxContentChars));
}

export function addActionLog({ agentId, actionType, targetPath, summary, rawAction, promptTokens, completionTokens, durationMs,
  model, reason, thinking, promptJson, modelResponse, toolResponse }) {
  const result = db.prepare(`
    INSERT INTO actions
    (agent_id, action_type, target_path, summary, raw_action, prompt_tokens, completion_tokens, duration_ms,
     model, reason, thinking, prompt_json, model_response, tool_response)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(agentId, actionType, targetPath || null, summary || null, rawAction || null,
    promptTokens || 0, completionTokens || 0, durationMs || 0,
    model || null, reason || null, thinking || null, promptJson || null, modelResponse || null, toolResponse || null);
  db.prepare('UPDATE agents SET action_count = action_count + 1 WHERE id = ?').run(agentId);
  return Number(result.lastInsertRowid);
}

export function saveOrientationReview({ agentId, actionId, reviewedTurnCount, proposedOrientation, confidence, reason,
  promptJson, modelResponse, promptTokens = 0, completionTokens = 0, error = null }) {
  const agent = getAgent(agentId);
  if (!agent) throw new Error(`Agent not found: ${agentId}`);
  const previousOrientation = agent.orientation;
  const nextOrientation = error ? previousOrientation : String(proposedOrientation || '').trim();
  if (!error && (!nextOrientation || nextOrientation.length > 2000)) {
    throw new Error('Orientation review must provide a nonempty orientation of at most 2000 characters.');
  }
  const confidenceLevel = error ? null : Number(confidence);
  if (!error && !(Number.isInteger(confidenceLevel) && confidenceLevel >= 1 && confidenceLevel <= 10)) {
    throw new Error('Orientation review must provide an integer confidence from 1 to 10.');
  }
  const rationale = String(error ? `Review failed: ${error.message}` : reason || '').trim();
  if (!rationale) throw new Error('Orientation review must provide a reason.');
  const outcome = error ? 'error' : nextOrientation === previousOrientation ? 'retained' : 'changed';
  const save = db.transaction(() => {
    if (outcome === 'changed') {
      db.prepare('UPDATE agents SET orientation = ? WHERE id = ?').run(nextOrientation, agentId);
    }
    if (confidenceLevel !== null) {
      db.prepare('UPDATE agents SET confidence = ? WHERE id = ?').run(confidenceLevel, agentId);
    }
    const info = db.prepare(`
      INSERT INTO orientation_reviews
      (agent_id, action_id, reviewed_turn_count, previous_orientation, current_orientation, confidence, rationale,
       outcome, prompt_json, model_response, prompt_tokens, completion_tokens)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(agentId, actionId, reviewedTurnCount, previousOrientation, nextOrientation, confidenceLevel, rationale, outcome,
      promptJson || null, modelResponse || null, promptTokens, completionTokens);
    return Number(info.lastInsertRowid);
  });
  const id = save();
  return { id, agent_id: agentId, action_id: actionId, reviewed_turn_count: reviewedTurnCount, previous_orientation: previousOrientation,
    current_orientation: nextOrientation, confidence: confidenceLevel, rationale, outcome, prompt_tokens: promptTokens,
    completion_tokens: completionTokens };
}

export function addUnderstanding(agentId, actionId, content) {
  const understanding = clip(content, config.maxContentChars).trim();
  if (!understanding) return;
  db.prepare('INSERT INTO understandings (agent_id, action_id, content) VALUES (?, ?, ?)')
    .run(agentId, actionId, understanding);
}

export function getRecentUnderstandings(limit = 50) {
  return db.prepare(`
    SELECT understandings.id, understandings.agent_id, understandings.action_id,
      understandings.content, understandings.created_at, actions.action_type,
      actions.target_path, actions.summary
    FROM understandings
    JOIN actions ON actions.id = understandings.action_id
    ORDER BY understandings.id DESC
    LIMIT ?
  `).all(Math.min(200, Math.max(1, Number(limit) || 50)));
}

export function getUnderstandingsPage(page = 0, pageSize = 10) {
  return pageOf('SELECT COUNT(*) AS count FROM understandings JOIN actions ON actions.id = understandings.action_id',
    `SELECT understandings.id, understandings.agent_id, understandings.action_id,
      understandings.content, understandings.created_at, actions.action_type,
      actions.target_path, actions.summary
    FROM understandings
    JOIN actions ON actions.id = understandings.action_id
    ORDER BY understandings.id DESC`, page, pageSize, 10);
}

export function getActionsPage(page = 0, pageSize = 15) {
  return pageOf('SELECT COUNT(*) AS count FROM actions',
    `SELECT id, agent_id, action_type, target_path, summary, model, reason,
    CASE WHEN thinking IS NOT NULL THEN 1 ELSE 0 END AS has_thinking,
    prompt_tokens, completion_tokens, duration_ms, created_at
    FROM actions ORDER BY id DESC`, page, pageSize, 15);
}

export function getRecentActions(limit = 100) {
  return db.prepare(`SELECT id, agent_id, action_type, target_path, summary, model, reason,
    CASE WHEN thinking IS NOT NULL THEN 1 ELSE 0 END AS has_thinking,
    prompt_tokens, completion_tokens, duration_ms, created_at
    FROM actions ORDER BY id DESC LIMIT ?`).all(Math.min(Number(limit) || 100, 500));
}

export function getAction(id) {
  return db.prepare('SELECT * FROM actions WHERE id = ?').get(id);
}

export function getStats() {
  return db.prepare(`
    SELECT
      (SELECT COUNT(*) FROM actions) AS actions,
      (SELECT COUNT(*) FROM objects WHERE type = 'artwork') AS artworks,
      (SELECT COUNT(*) FROM objects WHERE type = 'shared') AS shared_objects,
      (SELECT COALESCE(SUM(prompt_tokens), 0) FROM actions)
        + (SELECT COALESCE(SUM(prompt_tokens), 0) FROM orientation_reviews) AS prompt_tokens,
      (SELECT COALESCE(SUM(completion_tokens), 0) FROM actions)
        + (SELECT COALESCE(SUM(completion_tokens), 0) FROM orientation_reviews) AS completion_tokens
  `).get();
}

function ensureString(value) {
  return typeof value === 'string' ? value : '';
}

export function missingActionFields(action) {
  const required = [...({
    write: ['path', 'content'],
    publish: ['title', 'content'],
    revise: ['path', 'content'],
    generate_image: ['title', 'prompt'],
    inspect_image: ['path'],
    comment: ['path', 'content'],
    read: ['path']
  }[action?.type] || []), 'learning'];
  return required.filter(field => !ensureString(action?.[field]).trim());
}

function makeArtifactPath(id, title) {
  const slug = ensureString(title)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 40) || 'untitled';
  return `/artifacts/${String(id).padStart(5, '0')}-${slug}`;
}

export function executeAction(agent, action) {
  const type = action?.type;
  const missing = missingActionFields(action);
  if (missing.length) throw new Error(`${String(type).toUpperCase()} requires nonempty ${missing.join(' and ')}.`);

  if (type === 'list') {
    const path = ensureString(action.path) || '/';
    const items = listObjects(path);
    const result = items.length
      ? items.map(item => `${item.path} [${item.type}] ${item.title || ''}${item.type === 'artwork' ? ` (views ${item.view_count}, comments ${item.comment_count})` : ''} — ${clip(item.excerpt, 180)}`).join('\n')
      : `Nothing found under ${path}`;
    addMemory(agent.id, 'observation', `LIST ${path}\n${result}`);
    return { targetPath: path, summary: `Listed ${path}; found ${items.length} object(s).` };
  }

  if (type === 'read') {
    const path = ensureString(action.path);
    const object = getObjectByPath(path);
    const result = object
      ? `${object.path} [${object.image_file ? 'image artwork; use inspect_image if available' : object.type}] ${object.title || ''}\n${clip(object.content, config.maxContentChars)}${object.type === 'artwork' ? formatEngagement(object) : ''}`
      : `No object exists at ${path}`;
    addMemory(agent.id, 'observation', `READ ${path}\n${result}`);
    return { targetPath: path, summary: object ? `Read ${path}.` : `Tried to read missing path ${path}.` };
  }

  if (type === 'write') {
    const path = ensureString(action.path);
    const content = clip(action.content, config.maxContentChars);
    if (!path.startsWith('/shared/') || path === '/shared/') {
      throw new Error('WRITE is restricted to a specific path under /shared/.');
    }
    const info = db.prepare(`
      INSERT INTO objects (path, type, title, content, owner_agent_id)
      VALUES (?, 'shared', NULL, ?, ?)
    `).run(path, content, agent.id);
    addMemory(agent.id, 'action', `You wrote ${path}.`);
    return { targetPath: path, summary: `Wrote shared object ${path} (#${info.lastInsertRowid}).` };
  }

  if (type === 'publish') {
    const title = clip(action.title.trim(), 160);
    const content = clip(action.content, config.maxContentChars);
    const info = db.prepare(`
      INSERT INTO objects (path, type, title, content, owner_agent_id)
      VALUES ('pending', 'artwork', ?, ?, ?)
    `).run(title, content, agent.id);
    const path = makeArtifactPath(info.lastInsertRowid, title);
    db.prepare('UPDATE objects SET path = ? WHERE id = ?').run(path, info.lastInsertRowid);
    addMemory(agent.id, 'action', `You published “${title}” at ${path}.`);
    return { targetPath: path, summary: `Published artwork “${title}”.` };
  }

  if (type === 'revise') {
    const path = ensureString(action.path);
    const parent = getObjectByPath(path);
    if (!parent || parent.type !== 'artwork') {
      const examples = getArtworkPaths().slice(0, 5);
      throw new Error(`REVISE path ${JSON.stringify(path)} is not an existing artwork. ${examples.length ? `Valid paths include: ${examples.join(', ')}` : 'No artworks exist yet; publish first.'}`);
    }
    if (parent.image_file) throw new Error('Text revision of an image artwork is not available; publish a new text response instead.');
    const content = clip(action.content, config.maxContentChars);
    const title = clip(ensureString(action.title) || parent.title || 'Untitled revision', 160);
    const info = db.prepare(`
      INSERT INTO objects (path, type, title, content, owner_agent_id, parent_object_id, version)
      VALUES ('pending', 'artwork', ?, ?, ?, ?, ?)
    `).run(title, content, agent.id, parent.id, Number(parent.version || 1) + 1);
    const newPath = makeArtifactPath(info.lastInsertRowid, title);
    db.prepare('UPDATE objects SET path = ? WHERE id = ?').run(newPath, info.lastInsertRowid);
    addMemory(agent.id, 'action', `You revised ${path}; the new artifact is ${newPath}.`);
    return { targetPath: newPath, summary: `Revised ${path} as “${title}”.` };
  }

  if (type === 'comment') {
    const path = ensureString(action.path);
    const object = getObjectByPath(path);
    if (!object || object.type !== 'artwork') {
      const examples = getArtworkPaths().slice(0, 5);
      throw new Error(`COMMENT path ${JSON.stringify(path)} is not an existing artwork. ${examples.length ? `Valid paths include: ${examples.join(', ')}` : 'No artworks exist yet.'}`);
    }
    const content = clip(action.content.trim(), 2000);
    const info = db.prepare('INSERT INTO comments (object_id, agent_id, content) VALUES (?, ?, ?)')
      .run(object.id, agent.id, content);
    addMemory(agent.id, 'action', `You commented on ${path}: ${clip(content, 300)}`);
    return { targetPath: path, summary: `Commented on ${path}: “${clip(content, 200)}”`, commentId: Number(info.lastInsertRowid) };
  }

  if (type !== 'idle') throw new Error(`Unknown action ${JSON.stringify(type)}.`);
  addMemory(agent.id, 'action', 'You chose to take no external action this turn.');
  return { targetPath: null, summary: 'Idle.' };
}
