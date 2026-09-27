import Database from 'better-sqlite3';
import { agentDefinitions, criticDefinition } from '../agents.js';
import { config } from '../config.js';
import { dataDir, prepareStorage } from './storage.js';

export const storageState = await prepareStorage();

export const db = new Database(`${dataDir}/world.sqlite`);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

db.exec(`
CREATE TABLE IF NOT EXISTS agents (
  id TEXT PRIMARY KEY,
  orientation TEXT NOT NULL,
  initial_orientation TEXT NOT NULL DEFAULT '',
  model TEXT NOT NULL,
  active INTEGER NOT NULL DEFAULT 1,
  action_count INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS objects (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  path TEXT NOT NULL,
  type TEXT NOT NULL,
  title TEXT,
  content TEXT NOT NULL DEFAULT '',
  owner_agent_id TEXT,
  parent_object_id INTEGER,
  version INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY(owner_agent_id) REFERENCES agents(id),
  FOREIGN KEY(parent_object_id) REFERENCES objects(id)
);
CREATE INDEX IF NOT EXISTS idx_objects_path ON objects(path);
CREATE INDEX IF NOT EXISTS idx_objects_created ON objects(created_at DESC);

CREATE TABLE IF NOT EXISTS memories (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  agent_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  content TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY(agent_id) REFERENCES agents(id)
);
CREATE INDEX IF NOT EXISTS idx_memories_agent ON memories(agent_id, id DESC);

CREATE TABLE IF NOT EXISTS actions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  agent_id TEXT NOT NULL,
  action_type TEXT NOT NULL,
  target_path TEXT,
  summary TEXT,
  raw_action TEXT,
  prompt_tokens INTEGER NOT NULL DEFAULT 0,
  completion_tokens INTEGER NOT NULL DEFAULT 0,
  duration_ms INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY(agent_id) REFERENCES agents(id)
);
CREATE INDEX IF NOT EXISTS idx_actions_created ON actions(id DESC);

CREATE TABLE IF NOT EXISTS understandings (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  agent_id TEXT NOT NULL,
  action_id INTEGER NOT NULL UNIQUE,
  reviewed_turn_count INTEGER NOT NULL DEFAULT 0,
  content TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY(agent_id) REFERENCES agents(id),
  FOREIGN KEY(action_id) REFERENCES actions(id)
);
CREATE INDEX IF NOT EXISTS idx_understandings_created ON understandings(id DESC);

CREATE TABLE IF NOT EXISTS orientation_reviews (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  agent_id TEXT NOT NULL,
  action_id INTEGER NOT NULL UNIQUE,
  previous_orientation TEXT NOT NULL,
  current_orientation TEXT NOT NULL,
  rationale TEXT NOT NULL,
  outcome TEXT NOT NULL CHECK (outcome IN ('changed', 'retained', 'error')),
  prompt_json TEXT,
  model_response TEXT,
  prompt_tokens INTEGER NOT NULL DEFAULT 0,
  completion_tokens INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY(agent_id) REFERENCES agents(id),
  FOREIGN KEY(action_id) REFERENCES actions(id)
);
CREATE INDEX IF NOT EXISTS idx_orientation_reviews_agent ON orientation_reviews(agent_id, id DESC);

-- A view is an agent reading or inspecting an artwork, or an observer opening it in the dashboard.
-- after_action_id is the latest action when the view happened, so views can be placed between turns.
CREATE TABLE IF NOT EXISTS views (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  object_id INTEGER NOT NULL,
  viewer_kind TEXT NOT NULL CHECK (viewer_kind IN ('agent', 'observer')),
  agent_id TEXT,
  action_id INTEGER,
  after_action_id INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY(object_id) REFERENCES objects(id),
  FOREIGN KEY(agent_id) REFERENCES agents(id),
  FOREIGN KEY(action_id) REFERENCES actions(id)
);
CREATE INDEX IF NOT EXISTS idx_views_object ON views(object_id);

CREATE TABLE IF NOT EXISTS comments (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  object_id INTEGER NOT NULL,
  agent_id TEXT NOT NULL,
  action_id INTEGER,
  content TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY(object_id) REFERENCES objects(id),
  FOREIGN KEY(agent_id) REFERENCES agents(id),
  FOREIGN KEY(action_id) REFERENCES actions(id)
);
CREATE INDEX IF NOT EXISTS idx_comments_object ON comments(object_id, id);
`);

function addColumn(table, name, definition) {
  if (!db.pragma(`table_info(${table})`).some(column => column.name === name)) {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${name} ${definition}`);
  }
}

const capabilitiesWereMissing = !db.pragma('table_info(agents)').some(column => column.name === 'capabilities');
addColumn('agents', 'capabilities', "TEXT NOT NULL DEFAULT '[]'");
addColumn('agents', 'initial_orientation', "TEXT NOT NULL DEFAULT ''");
db.prepare("UPDATE agents SET initial_orientation = orientation WHERE initial_orientation = ''").run();
addColumn('orientation_reviews', 'reviewed_turn_count', 'INTEGER NOT NULL DEFAULT 0');
addColumn('orientation_reviews', 'confidence', 'INTEGER');
addColumn('agents', 'confidence', 'INTEGER');
addColumn('agents', 'role', "TEXT NOT NULL DEFAULT 'artist'");
db.prepare(`UPDATE agents SET confidence = (
  SELECT confidence FROM orientation_reviews
  WHERE orientation_reviews.agent_id = agents.id AND confidence IS NOT NULL ORDER BY id DESC LIMIT 1
) WHERE confidence IS NULL`).run();
addColumn('objects', 'image_file', 'TEXT');
for (const [name, type] of [
  ['model', 'TEXT'], ['reason', 'TEXT'], ['thinking', 'TEXT'],
  ['prompt_json', 'TEXT'], ['model_response', 'TEXT'], ['tool_response', 'TEXT'],
  ['confidence', 'INTEGER'], ['confidence_reason', 'TEXT']
]) addColumn('actions', name, type);

const defaults = [
  ['A01', ['image_generation']], ['A02', ['image_vision']],
  ['A03', []], ['A04', ['image_generation', 'image_vision']],
  ['A05', ['image_vision']], ['A06', []]
];
const insertAgent = db.prepare(`
  INSERT OR IGNORE INTO agents (id, orientation, initial_orientation, model, capabilities)
  VALUES (@id, @orientation, @orientation, @model, @capabilities)
`);
for (const agent of agentDefinitions) {
  insertAgent.run({ ...agent, model: config.defaultModel,
    capabilities: JSON.stringify(defaults.find(([id]) => id === agent.id)?.[1] || []) });
}
// Inactive, so the critic is never scheduled for a turn; the runner invokes it separately.
db.prepare(`
  INSERT OR IGNORE INTO agents (id, orientation, initial_orientation, model, capabilities, role, active)
  VALUES (?, ?, ?, ?, ?, 'critic', 0)
`).run(criticDefinition.id, criticDefinition.orientation, criticDefinition.orientation, config.defaultModel,
  JSON.stringify(['image_vision']));
if (capabilitiesWereMissing) {
  const migrate = db.prepare('UPDATE agents SET capabilities = ? WHERE id = ?');
  for (const [id, capabilities] of defaults) migrate.run(JSON.stringify(capabilities), id);
}

const worldExists = db.prepare("SELECT 1 FROM objects WHERE path = '/world/charge' LIMIT 1").get();
if (!worldExists) {
  db.prepare(`INSERT INTO objects (path, type, title, content, owner_agent_id)
              VALUES (?, 'world', 'Charge', ?, NULL)`)
    .run('/world/charge', config.charge);
}
