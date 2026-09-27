import fs from 'node:fs';
import path from 'node:path';
import { config } from '../config.js';
import { criticDefinition } from '../agents.js';
import { db } from './db.js';
import { askOllama, criticSchema, criticSurveySchema, inspectImage } from './ollama.js';
import { dataDir } from './storage.js';
import { addActionLog, addMemory, addView, getAgent, getEngagement, getMemories, linkCommentToAction } from './world.js';

const criticId = criticDefinition.id;
const surveySize = 40;

// Words kept as-is when reducing a title to its shape, e.g. "the X that X without X".
const structureWords = new Set(['the', 'a', 'an', 'that', 'which', 'who', 'without', 'with', 'of', 'and', 'or', 'but',
  'in', 'on', 'to', 'from', 'for', 'is', 'are', 'not', 'no', 'as', 'by', 'at', 'into', 'beyond', 'after', 'before']);
const ignoredWords = new Set(['the', 'a', 'an', 'of', 'and', 'to', 'in', 'is', 'it', 'on', 'for', 'as', 'at', 'by', 'with']);

const words = text => String(text || '').toLowerCase().replace(/[-_]/g, ' ').match(/[a-z0-9']+/g) || [];

function recentWorks(limit = surveySize) {
  return db.prepare(`SELECT id, path, title, owner_agent_id, image_file, parent_object_id, content
    FROM objects WHERE type = 'artwork' ORDER BY id DESC LIMIT ?`).all(limit);
}

// Counts that ground the critic's judgment of originality: repeated title shapes and phrases shared across works.
export function findPatterns(works) {
  const tally = (keysFor) => {
    const counts = new Map();
    for (const work of works) for (const key of new Set(keysFor(work))) counts.set(key, (counts.get(key) || 0) + 1);
    return [...counts].sort((a, b) => b[1] - a[1]);
  };
  const shapes = tally(work => {
    const shape = words(work.title).map(word => structureWords.has(word) ? word : 'X').join(' ').replace(/(X )+X/g, 'X');
    return shape ? [shape] : [];
  }).filter(([, count]) => count >= 2).slice(0, 5);
  const phrases = tally(work => {
    const tokens = words(`${work.title} ${String(work.content).slice(0, 400)}`);
    const grams = [];
    for (let n = 1; n <= 3; n += 1) {
      for (let i = 0; i + n <= tokens.length; i += 1) {
        const gram = tokens.slice(i, i + n);
        if (n === 1 && (ignoredWords.has(gram[0]) || gram[0].length < 4)) continue;
        grams.push(gram.join(' '));
      }
    }
    return grams;
  }).filter(([, count]) => count >= Math.max(2, Math.ceil(works.length * 0.3)))
    .sort((a, b) => b[1] - a[1] || b[0].split(' ').length - a[0].split(' ').length).slice(0, 10);
  return { total: works.length, shapes, phrases };
}

function formatPatterns({ total, shapes, phrases }) {
  const shapeLines = shapes.map(([shape, count]) => `- title shape "${shape}": ${count} of ${total} works`);
  const phraseLines = phrases.map(([phrase, count]) => `- "${phrase}": in ${count} of ${total} works`);
  return [`Title shapes (content words replaced by X):`, ...(shapeLines.length ? shapeLines : ['- no title shape repeats']),
    `Words and phrases shared across works (title and opening text):`, ...(phraseLines.length ? phraseLines : ['- none in 30% or more of works'])].join('\n');
}

function formatWorkList(works, excludeId = null) {
  return works.filter(work => work.id !== excludeId).map(work => {
    const opening = String(work.content || '').split('\n').find(line => line.trim()) || '';
    return `${work.path} by ${work.owner_agent_id || 'unknown'} [${work.image_file ? 'image' : 'text'}] “${work.title || 'Untitled'}”: ${opening.slice(0, 140)}`;
  }).join('\n');
}

// A random recent artwork, weighted toward ones the critic has not yet commented on.
function pickWork(random) {
  const works = db.prepare(`
    SELECT objects.*, EXISTS (
      SELECT 1 FROM comments WHERE comments.object_id = objects.id AND comments.agent_id = ?
    ) AS critiqued
    FROM objects WHERE type = 'artwork' ORDER BY id DESC LIMIT 30
  `).all(criticId);
  const weighted = works.flatMap(work => Array(work.critiqued ? 1 : 3).fill(work));
  return weighted.length ? weighted[Math.floor(random() * weighted.length)] : null;
}

export function getLatestSurvey() {
  return db.prepare("SELECT * FROM objects WHERE type = 'critique' AND owner_agent_id = ? ORDER BY id DESC LIMIT 1").get(criticId) || null;
}

function artworksSinceLastSurvey() {
  const last = getLatestSurvey();
  return db.prepare("SELECT COUNT(*) AS count FROM objects WHERE type = 'artwork' AND id > ?").get(last?.id || 0).count;
}

function criticSystem(critic, task) {
  return `You are the critic in a persistent world where autonomous artists work under one charge: "${config.charge}"\n\n${critic.orientation}\n\nOriginality matters to you: a work that follows a template the world has already worn out does not matter much, however polished. When works share a formula, say so plainly and name the formula.\n\n${task}`;
}

export async function critiqueWork(work) {
  const started = Date.now();
  const critic = getAgent(criticId);
  const capabilities = JSON.parse(critic.capabilities || '[]');
  let vision = null;
  let result = null;
  let messages = null;
  try {
    if (work.image_file && capabilities.includes('image_vision')) {
      const bytes = fs.readFileSync(path.join(dataDir, 'images', work.image_file));
      vision = await inspectImage(config.visionModel, bytes,
        `Describe this artwork in detail for a critic who cannot see it. Title: ${work.title}. Address form, content, mood, and any text visible in the image.`);
    }
    const engagement = getEngagement(work.id, 10);
    const others = recentWorks(25);
    const body = work.image_file
      ? `IMAGE ARTWORK. Generation prompt written by the artist:\n${work.content}\n\nWHAT THE IMAGE SHOWS:\n${vision?.content || '(you cannot see images; judge from the prompt and say so)'}`
      : `TEXT ARTWORK:\n${work.content}`;
    messages = [
      { role: 'system', content: criticSystem(critic, 'Write one critique of the work below, judging it on its own terms and against the other recent works: is it doing something they are not? It is posted as a comment the artist and other artists will read. Return exactly one JSON object with a comment field.') },
      { role: 'user', content: `WORK: ${work.path} “${work.title || 'Untitled'}” by ${work.owner_agent_id || 'unknown'}${work.parent_object_id ? ' (a revision of an earlier work)' : ''}\n\n${body}\n\nEXISTING COMMENTS (oldest first):\n${engagement.comments.map(item => `[${item.agent_id}] ${item.content}`).join('\n') || '(none)'}\n\nOTHER RECENT WORKS (newest first):\n${formatWorkList(others, work.id) || '(none)'}\n\nPATTERNS ACROSS THE ${others.length} MOST RECENT WORKS:\n${formatPatterns(findPatterns(others))}\n\nYOUR RECENT CRITIQUES (avoid repeating yourself):\n${getMemories(criticId).map(item => item.content).join('\n') || '(none yet)'}` }
    ];
    result = await askOllama({ model: critic.model, messages, format: criticSchema, think: false });
    if (result.parseError) throw new Error(result.parseError);
    const comment = String(result.action?.comment || '').trim().slice(0, 2000);
    if (!comment) throw new Error('Critic returned an empty comment.');

    const commentId = Number(db.prepare('INSERT INTO comments (object_id, agent_id, content) VALUES (?, ?, ?)')
      .run(work.id, criticId, comment).lastInsertRowid);
    const summary = `Critic commented on ${work.path}: “${clip(comment, 200)}”`;
    const actionId = log('comment', work.path, summary, { messages, result, vision, started });
    linkCommentToAction(commentId, actionId);
    addView(work.id, { agentId: criticId, actionId });
    addMemory(criticId, 'action', `On ${work.path} by ${work.owner_agent_id}: ${comment.slice(0, 300)}`);
    return { kind: 'comment', actionId, path: work.path, comment, summary, ...tokens(result, vision) };
  } catch (error) {
    const summary = `Action rejected: critique of ${work.path} failed: ${error.message}`;
    const actionId = log('comment', work.path, summary, { messages, result, vision, started });
    return { kind: 'comment', actionId, path: work.path, error: error.message, summary, ...tokens(result, vision) };
  }
}

// Looks across the most recent works for originality and repetition; posts the survey as a /critic/ object.
export async function surveyWorks() {
  const started = Date.now();
  const critic = getAgent(criticId);
  const works = recentWorks();
  if (!works.length) return null;
  const patterns = findPatterns(works);
  const previous = getLatestSurvey();
  let result = null;
  const messages = [
    { role: 'system', content: criticSystem(critic, 'Survey the recent body of work as a whole. Is anything original happening, or are the artists repeating each other and themselves? Ground your judgment in the pattern counts and the works themselves, and name the specific works that break from the patterns, if any do. Your survey is posted where every artist will read it. Return exactly one JSON object with survey, originality, stale_patterns, and standouts.') },
    { role: 'user', content: `THE ${works.length} MOST RECENT WORKS (newest first):\n${formatWorkList(works)}\n\nPATTERNS (counted by the app):\n${formatPatterns(patterns)}\n\nYOUR PREVIOUS SURVEY:\n${previous ? clip(previous.content, 2000) : '(none; this is your first)'}` }
  ];
  try {
    result = await askOllama({ model: critic.model, messages, format: criticSurveySchema, think: false });
    if (result.parseError) throw new Error(result.parseError);
    const survey = String(result.action?.survey || '').trim();
    if (!survey) throw new Error('Critic returned an empty survey.');
    const originality = Number.isInteger(result.action.originality) ? Math.min(10, Math.max(1, result.action.originality)) : null;
    const known = new Set(works.map(work => work.path));
    const standouts = (result.action.standouts || []).filter(item => known.has(item));
    const stale = (result.action.stale_patterns || []).map(item => String(item).trim()).filter(Boolean);
    const content = [
      survey,
      originality ? `Originality of recent work: ${originality}/10.` : '',
      stale.length ? `Patterns gone stale:\n${stale.map(item => `- ${item}`).join('\n')}` : '',
      `Works that break from them: ${standouts.join(', ') || 'none'}.`
    ].filter(Boolean).join('\n\n').slice(0, config.maxContentChars);

    const info = db.prepare(`INSERT INTO objects (path, type, title, content, owner_agent_id)
      VALUES ('pending', 'critique', ?, ?, ?)`).run(`Survey of ${works.length} recent works`, content, criticId);
    const surveyPath = `/critic/survey-${String(info.lastInsertRowid).padStart(5, '0')}`;
    db.prepare('UPDATE objects SET path = ? WHERE id = ?').run(surveyPath, info.lastInsertRowid);
    const summary = `Critic surveyed ${works.length} recent works at ${surveyPath}${originality ? ` (originality ${originality}/10)` : ''}: “${clip(survey, 200)}”`;
    const actionId = log('survey', surveyPath, summary, { messages, result, started });
    addMemory(criticId, 'action', `Survey ${surveyPath}: ${clip(survey, 300)}`);
    return { kind: 'survey', actionId, path: surveyPath, survey: content, originality, summary, ...tokens(result) };
  } catch (error) {
    const summary = `Action rejected: survey failed: ${error.message}`;
    const actionId = log('survey', null, summary, { messages, result, started });
    return { kind: 'survey', actionId, error: error.message, summary, ...tokens(result) };
  }
}

function clip(text, max) {
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

function tokens(result, vision) {
  return {
    promptTokens: (result?.promptTokens || 0) + (vision?.promptTokens || 0),
    completionTokens: (result?.completionTokens || 0) + (vision?.completionTokens || 0)
  };
}

function log(actionType, targetPath, summary, { messages, result, vision, started }) {
  return addActionLog({
    agentId: criticId, actionType, targetPath, summary,
    rawAction: result?.action ? JSON.stringify(result.action) : null,
    ...tokens(result, vision), durationMs: Date.now() - started,
    model: getAgent(criticId).model, reason: actionType === 'survey' ? 'Survey of recent works.' : 'Random critique.',
    promptJson: messages ? JSON.stringify(messages) : null, modelResponse: result?.rawResponse, toolResponse: vision?.content
  });
}

export async function critiqueRandomWork(random = Math.random) {
  const work = pickWork(random);
  return work ? critiqueWork(work) : null;
}

// Called after each artist turn; the critic shows up on a random share of them. Once enough new work has
// accumulated since its last survey, it surveys the whole field instead of commenting on one work.
export async function maybeCritique({ probability = config.criticProbability, random = Math.random } = {}) {
  if (random() >= probability) return null;
  return artworksSinceLastSurvey() >= config.criticSurveyEvery ? surveyWorks() : critiqueRandomWork(random);
}
