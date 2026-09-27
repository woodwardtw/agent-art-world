import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import Database from 'better-sqlite3';

const previousDir = process.cwd();
const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-art-smoke-'));
process.chdir(workDir);
process.env.AGENT_DATA_DIR = path.join(workDir, 'stable-data');
process.env.AGENT_EXPORT_DIR = path.join(workDir, 'exports');
process.env.CRITIC_PROBABILITY = '0'; // the critic is exercised explicitly below
const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScL/nwAAAABJRU5ErkJggg==';
// Stand-in for mflux-generate-z-image-turbo: writes a 1x1 PNG to --output.
process.env.MFLUX_COMMAND = path.join(workDir, 'fake-mflux');
fs.writeFileSync(process.env.MFLUX_COMMAND, `#!${process.execPath}
const args = process.argv.slice(2);
if (args[args.indexOf('--prompt') + 1] !== 'A blue shape') process.exit(2);
require('node:fs').writeFileSync(args[args.indexOf('--output') + 1], Buffer.from('${png}', 'base64'));
`, { mode: 0o755 });
const { nextAgentId, runAgentTurn } = await import('../lib/runner.js');
const { critiqueWork, maybeCritique } = await import('../lib/critic.js');
const { db } = await import('../lib/db.js');
const { dataDir, migrateData } = await import('../lib/storage.js');
const { exportGallery } = await import('../lib/export-gallery.js');
const { addView, getActionsPage, getArtworksPage, getEngagement, getConfidenceHistory, getImageActivity, getObjectsPage, getUnderstandingsPage, getOrientationReviews, getRecentUnderstandings } = await import('../lib/world.js');

const steps = [
  { type: 'publish', title: 'First work', content: 'A small poem', reason: 'Try a form.' },
  { type: 'revise', path: '/artifacts/does-not-exist', title: 'Wrong', content: 'No', reason: 'Attempt revision.' },
  { type: 'revise', path: '/artifacts/00002-first-work', title: 'New version', content: 'A revised poem', reason: 'Improve form.' },
  { type: 'generate_image', title: 'Blue', prompt: 'A blue shape', reason: 'Explore color.' },
  { type: 'inspect_image', path: '/artifacts/00004-blue', reason: 'Observe the work.' },
  { type: 'publish', reason: 'Respond with a poem.' },
  { type: 'publish', title: 'A response', content: 'The finished poem.', reason: 'Respond with a poem.', expectedThink: false },
  { type: 'publish', title: 'An empty work', content: '  ', reason: 'Try again.' },
  { type: 'publish', title: 'Still empty', content: '', reason: 'Try again.', expectedThink: false },
  { thinkingOnly: true },
  { type: 'publish', title: 'Recovered', content: 'Recovered work.', reason: 'A complete response.', expectedThink: false },
  { type: 'idle', reason: 'Pause.' },
  { type: 'idle', reason: 'Consider recent work.', confidence: 4, confidence_reason: 'A02 inspected my image and found only color, not structure.' },
  { type: 'idle', reason: 'Continue the experiment.' },
  { type: 'comment', path: '/artifacts/00004-blue', content: 'The blue holds, but where is the structure?', reason: 'Respond to the work.' },
  { type: 'idle', reason: 'Take in the response.' },
  { type: 'read', path: '/artifacts/00004-blue', reason: 'See what others said.' },
  { type: 'idle', reason: 'Weigh the critique.' }
];
const originalOrientation = db.prepare("SELECT initial_orientation FROM agents WHERE id = 'A01'").get().initial_orientation;
let calls = 0;
globalThis.fetch = async (url, options) => {
  const input = JSON.parse(options.body);
  if (!input.format) {
    assert.equal(input.messages[0].images.length, 1);
    return Response.json({ message: { content: 'A blue square.' }, prompt_eval_count: 20, eval_count: 6 });
  }
  if (input.format.properties.survey) {
    assert.match(input.messages[0].content, /Survey the recent body of work/);
    assert.match(input.messages[1].content, /title shape "the X that X without X": 3 of \d+ works/);
    return Response.json({ message: { content: JSON.stringify({ survey: 'The field repeats one formula.', originality: 3,
      stale_patterns: ['Titles shaped "the X that X without X"'], standouts: ['/artifacts/00004-blue', '/artifacts/not-real'] }) },
    prompt_eval_count: 13, eval_count: 7 });
  }
  if (input.format.properties.comment) {
    assert.match(input.messages[0].content, /You are the critic/);
    const work = input.messages[1].content.match(/^WORK: (\S+)/)[1];
    return Response.json({ message: { content: JSON.stringify({ comment: `The critic finds ${work} earnest but unfinished.` }) },
      prompt_eval_count: 11, eval_count: 5 });
  }
  if (!input.format.properties.type) {
    assert.deepEqual(input.format.required, ['orientation', 'confidence', 'reason']);
    assert.match(input.messages[0].content, /confidence is an integer from 1 to 10/);
    assert.match(input.messages[0].content, /Reconsider your private orientation after turn 5/);
    assert.match(input.messages[1].content, /ORIGINAL PRIVATE ORIENTATION \(immutable baseline\):/);
    assert.match(input.messages[1].content, /YOUR CONFIDENCE IN YOUR CURRENT ORIENTATION:\n6\/10/);
    assert.match(input.messages[1].content, /YOUR RECENT ARTWORKS[\s\S]*First work/);
    return Response.json({ message: { content: JSON.stringify({
      orientation: 'A01 now considers how formal invention invites response.',
      confidence: 7,
      reason: 'Repeated work and responses show form matters through what it enables others to do.'
    }) }, prompt_eval_count: 17, eval_count: 4 });
  }
  const { expectedThink = true, thinkingOnly = false, ...step } = steps[calls++] || {};
  assert.ok(input.format.required.includes('learning'));
  assert.match(input.messages[0].content, /exactly these keys: type, reason, path, title, content, prompt, learning, confidence, confidence_reason\./);
  assert.ok(input.format.required.includes('confidence'));
  if (calls === 1) assert.match(input.messages[1].content, /YOUR CONFIDENCE IN YOUR PRIVATE ORIENTATION:\nNot yet rated/);
  assert.equal(input.think, expectedThink);
  assert.match(input.messages[0].content, /The app assigns the new \/artifacts\/ path/);
  if (calls === 2) {
    assert.match(input.messages[1].content, /RECENT SHARED ACTION OUTCOMES[\s\S]*A01.*Published artwork/);
    assert.match(input.messages[1].content, /SHARED EVOLUTION LOG[\s\S]*A01.*This turn suggests/);
  }
  if (thinkingOnly) return Response.json({ message: { content: '', thinking: 'I keep reconsidering the output format.' }, prompt_eval_count: 42, eval_count: 150 });
  assert.ok(input.format.properties.type.enum.includes(step.type));
  const action = { learning: `This turn suggests that ${step.type} can matter through its response to earlier work.`,
    confidence: 6, confidence_reason: 'Nothing this turn bore on my orientation.', ...step };
  return Response.json({ message: { content: JSON.stringify(action), thinking: `Trace for ${step.type}` },
    prompt_eval_count: 42, eval_count: 9 });
};

const first = await runAgentTurn('A01');
assert.equal(first.execution.targetPath, '/artifacts/00002-first-work');
assert.match(first.learning, /This turn suggests/);
assert.equal(getRecentUnderstandings(1)[0].action_id, 1);
assert.equal(first.confidence, 6);
assert.equal(db.prepare("SELECT confidence FROM agents WHERE id = 'A01'").get().confidence, 6);
const imageCapablePrompt = JSON.parse(db.prepare('SELECT prompt_json FROM actions ORDER BY id DESC LIMIT 1').get().prompt_json)[0].content;
assert.match(imageCapablePrompt, /generate_image \(IMAGE artwork\): type="generate_image"/);
assert.match(imageCapablePrompt, /content=null, prompt=complete visual description/);
const rejected = await runAgentTurn('A02');
assert.match(rejected.execution.summary, /does-not-exist/);
assert.match(rejected.execution.summary, /00002-first-work/);
const revised = await runAgentTurn('A01');
assert.match(revised.execution.summary, /Revised/);
const image = await runAgentTurn('A01');
assert.equal(image.execution.targetPath, '/artifacts/00004-blue');
assert.equal(db.prepare('SELECT COUNT(*) AS count FROM objects WHERE image_file IS NOT NULL').get().count, 1);
assert.equal(getImageActivity().created, 1);
assert.equal(getImageActivity().attempts, 1);
assert.match(getImageActivity().lastAttempt.summary, /Generated image/);
const inspected = await runAgentTurn('A02');
assert.match(inspected.execution.summary, /Inspected image/);
assert.match(db.prepare("SELECT content FROM memories WHERE agent_id = 'A02' AND kind = 'observation' ORDER BY id DESC LIMIT 1").get().content, /blue square/);
const trace = db.prepare('SELECT * FROM actions ORDER BY id DESC LIMIT 1').get();
assert.equal(trace.thinking, 'Trace for inspect_image');
assert.match(trace.prompt_json, /EXISTING ARTWORK PATHS FOR REVISE/);
assert.equal(trace.reason, 'Observe the work.');
assert.equal(trace.tool_response, 'A blue square.');
assert.equal(trace.prompt_tokens, 62);
const repaired = await runAgentTurn('A03');
assert.match(repaired.execution.summary, /Published artwork “A response”/);
const repairTrace = db.prepare('SELECT * FROM actions ORDER BY id DESC LIMIT 1').get();
assert.equal(repairTrace.prompt_tokens, 84);
assert.equal(JSON.parse(repairTrace.prompt_json).length, 2);
assert.match(repairTrace.model_response, /"attempt": 1/);
const before = db.prepare('SELECT COUNT(*) AS count FROM objects').get().count;
const rejectedEmpty = await runAgentTurn('A03');
assert.match(rejectedEmpty.execution.summary, /No object was created/);
assert.equal(db.prepare('SELECT COUNT(*) AS count FROM objects').get().count, before);
const recovered = await runAgentTurn('A05');
assert.match(recovered.execution.summary, /Published artwork “Recovered”/);
const recoveredTrace = db.prepare('SELECT * FROM actions ORDER BY id DESC LIMIT 1').get();
assert.match(recoveredTrace.thinking, /reconsidering the output format/);
assert.equal(JSON.parse(recoveredTrace.prompt_json).length, 2);
const gallery = getArtworksPage(0, 2);
assert.equal(gallery.items.length, 2);
assert.equal(gallery.total, 5);
assert.equal(getArtworksPage(1, 2).items.length, 2);
assert.equal(getArtworksPage(99, 2).page, 2); // past the end clamps to the last page
assert.equal(getArtworksPage(99, 2).items.length, 1);
const actionPage = getActionsPage(0, 3);
assert.equal(actionPage.items.length, 3);
assert.equal(actionPage.total, db.prepare('SELECT COUNT(*) AS count FROM actions').get().count);
assert.ok(actionPage.items[0].id > actionPage.items[2].id);
assert.equal(getObjectsPage(0, 2).items.length, 2);
assert.equal(getUnderstandingsPage(0, 1).items.length, 1);
const exported = await exportGallery();
assert.equal(exported.count, 5);
const exportedManifest = JSON.parse(fs.readFileSync(path.join(exported.destination, 'manifest.json'), 'utf8'));
assert.equal(exportedManifest.artworks.length, 5);
assert.ok(fs.existsSync(path.join(exported.destination, 'world.sqlite')));
assert.ok(fs.existsSync(path.join(exported.destination, 'images', exportedManifest.artworks.find(item => item.image_file).image_file.split('/').pop())));
assert.match(fs.readFileSync(path.join(exported.destination, 'index.html'), 'utf8'), /The finished poem\./);
assert.ok(fs.existsSync(path.join(dataDir, 'world.sqlite')));
const recoveredDir = path.join(workDir, 'recovered-data');
await migrateData(exported.destination, recoveredDir);
const recoveredDb = new Database(path.join(recoveredDir, 'world.sqlite'), { readonly: true });
assert.equal(recoveredDb.prepare("SELECT COUNT(*) AS count FROM objects WHERE type = 'artwork'").get().count, 5);
recoveredDb.close();
assert.ok(fs.existsSync(path.join(recoveredDir, 'images', exportedManifest.artworks.find(item => item.image_file).image_file.split('/').pop())));
const autoInstall = path.join(workDir, 'auto-install');
fs.mkdirSync(autoInstall);
fs.cpSync(exported.destination, path.join(autoInstall, 'data'), { recursive: true });
const autoData = path.join(autoInstall, 'stable-data');
const moduleUrl = new URL('../lib/db.js', import.meta.url).href;
const auto = spawnSync(process.execPath, ['--input-type=module', '-e',
  `import { db, storageState } from ${JSON.stringify(moduleUrl)}; if (!storageState.migratedFrom || db.prepare("SELECT COUNT(*) AS count FROM objects WHERE type = 'artwork'").get().count !== 5) process.exitCode = 1; db.close();`],
{ cwd: autoInstall, env: { ...process.env, AGENT_DATA_DIR: autoData }, encoding: 'utf8' });
assert.equal(auto.status, 0, auto.stderr);
assert.ok(fs.existsSync(path.join(autoData, 'images', exportedManifest.artworks.find(item => item.image_file).image_file.split('/').pop())));
const insert = db.prepare("INSERT INTO objects (path, type, title, content, owner_agent_id) VALUES (?, 'artwork', ?, ?, 'A01')");
for (let i = 0; i < 12; i += 1) insert.run(`/artifacts/seed-${i}`, `Seed ${i}`, `Seed work ${i}`);
await runAgentTurn('A03');
const limitedTrace = db.prepare('SELECT prompt_json FROM actions ORDER BY id DESC LIMIT 1').get();
const limitedPrompt = JSON.parse(limitedTrace.prompt_json)[1].content;
assert.equal((limitedPrompt.match(/\[artwork owner=/g) || []).length, 8);
assert.doesNotMatch(limitedPrompt, /\[reflection\]/);
assert.match(limitedPrompt, /use list or read to discover/);
const fourthTurn = await runAgentTurn('A01');
assert.equal(fourthTurn.orientationReview, null);
const fourthPrompt = JSON.parse(db.prepare('SELECT prompt_json FROM actions ORDER BY id DESC LIMIT 1').get().prompt_json)[1].content;
assert.match(fourthPrompt, /RESPONSES TO YOUR WORK SINCE YOUR LAST TURN[^\n]*\n\[A02 · inspect_image · action \d+ · \/artifacts\/00004-blue\]/);
assert.equal(fourthTurn.confidence, 4);
assert.match(db.prepare("SELECT content FROM memories WHERE agent_id = 'A01' AND kind = 'confidence' ORDER BY id DESC LIMIT 1").get().content, /6 → 4: A02 inspected/);
assert.equal(getOrientationReviews('A01').length, 0);
const fifthTurn = await runAgentTurn('A01');
assert.equal(fifthTurn.orientationReview.outcome, 'changed');
assert.equal(fifthTurn.promptTokens, 59);
const orientation = db.prepare("SELECT orientation, initial_orientation FROM agents WHERE id = 'A01'").get();
assert.equal(orientation.orientation, 'A01 now considers how formal invention invites response.');
assert.equal(orientation.initial_orientation, originalOrientation);
assert.equal(getOrientationReviews('A01')[0].previous_orientation, originalOrientation);
assert.equal(getOrientationReviews('A01')[0].confidence, 7);
assert.equal(db.prepare("SELECT confidence FROM agents WHERE id = 'A01'").get().confidence, 7);
const confidenceHistory = getConfidenceHistory('A01');
assert.deepEqual(confidenceHistory.slice(0, 3).map(item => [item.source, item.previous, item.confidence]),
  [['review', 6, 7], ['turn', 4, 6], ['turn', 6, 4]]);

// Comments and views: A02 comments on A01's image, an observer views it, A01 sees both, A03 reads the counts.
const commented = await runAgentTurn('A02');
assert.match(commented.execution.summary, /Commented on \/artifacts\/00004-blue/);
const blue = db.prepare("SELECT id FROM objects WHERE path = '/artifacts/00004-blue'").get();
assert.equal(addView(blue.id), true);
assert.equal(addView(db.prepare("SELECT id FROM objects WHERE type = 'shared' LIMIT 1").get()?.id ?? -1), false);
const authorTurn = await runAgentTurn('A01');
const authorPrompt = JSON.parse(db.prepare('SELECT prompt_json FROM actions ORDER BY id DESC LIMIT 1').get().prompt_json);
assert.match(authorPrompt[0].content, /- comment: leave a comment on an existing artwork/);
assert.match(authorPrompt[1].content, /\[A02 · comment · action \d+ · \/artifacts\/00004-blue\] Commented on [^\n]*where is the structure/);
assert.match(authorPrompt[1].content, /Outside observers viewed: \/artifacts\/00004-blue \(1\)/);
assert.match(authorPrompt[1].content, /\[artwork owner=A01\] “Seed 11” · views 0 \(0 by outside observers\) · comments 0/);
assert.equal(authorTurn.execution.summary, 'Idle.');
await runAgentTurn('A03');
assert.match(db.prepare("SELECT content FROM memories WHERE agent_id = 'A03' AND kind = 'observation' ORDER BY id DESC LIMIT 1").get().content,
  /Views: 2 \(1 by agents, 1 by outside observers\)\. Comments: 1\n  \[A02\] The blue holds/);
const engagement = getEngagement(blue.id);
assert.deepEqual([engagement.views, engagement.agent_views, engagement.observer_views, engagement.comment_count], [3, 2, 1, 1]);
assert.ok(engagement.comments[0].action_id);
assert.equal(getArtworksPage(0, 24).items.find(item => item.id === blue.id).comment_count, 1);

// The critic: never scheduled, comments when invoked, and its comments reach the author.
assert.equal(db.prepare("SELECT active, role FROM agents WHERE id = 'CRITIC'").get().role, 'critic');
assert.notEqual(nextAgentId(), 'CRITIC');
assert.equal(await maybeCritique({ probability: 0 }), null);
for (const title of ['the-glass-that-holds-without-breaking', 'the-rope-that-binds-without-knotting', 'the-bell-that-rings-without-sound']) {
  insert.run(`/artifacts/${title}`, title, 'there is a thing that does without doing');
}
// Enough new work since the last survey (none yet), so the critic surveys instead of commenting.
const survey = await maybeCritique({ probability: 1, random: () => 0 });
assert.equal(survey.kind, 'survey');
assert.match(survey.path, /^\/critic\/survey-\d{5}$/);
assert.equal(survey.originality, 3);
assert.match(survey.survey, /Works that break from them: \/artifacts\/00004-blue\.$/);
assert.equal(db.prepare('SELECT type FROM objects WHERE path = ?').get(survey.path).type, 'critique');
const randomCritique = await maybeCritique({ probability: 1, random: () => 0 });
assert.equal(randomCritique.kind, 'comment');
assert.match(randomCritique.summary, /^Critic commented on \/artifacts\//);
assert.match(JSON.parse(db.prepare('SELECT prompt_json FROM actions WHERE id = ?').get(randomCritique.actionId).prompt_json)[1].content,
  /OTHER RECENT WORKS[\s\S]*PATTERNS ACROSS THE \d+ MOST RECENT WORKS/);
const imageCritique = await critiqueWork(db.prepare("SELECT * FROM objects WHERE path = '/artifacts/00004-blue'").get());
assert.equal(imageCritique.comment, 'The critic finds /artifacts/00004-blue earnest but unfinished.');
const critiquePrompt = JSON.parse(db.prepare('SELECT prompt_json FROM actions WHERE id = ?').get(imageCritique.actionId).prompt_json);
assert.match(critiquePrompt[1].content, /WHAT THE IMAGE SHOWS:\nA blue square\./);
assert.match(critiquePrompt[1].content, /\[A02\] The blue holds/);
assert.equal(getEngagement(blue.id).comments.at(-1).agent_id, 'CRITIC');
await runAgentTurn('A01');
const afterCritique = JSON.parse(db.prepare("SELECT prompt_json FROM actions WHERE agent_id = 'A01' ORDER BY id DESC LIMIT 1").get().prompt_json)[1].content;
assert.match(afterCritique, /\[CRITIC · comment · action \d+ · \/artifacts\/00004-blue\] Critic commented/);
assert.match(afterCritique, /THE CRITIC'S LATEST SURVEY OF RECENT WORK \(\/critic\/survey-\d{5}\):\nThe field repeats one formula\./);

db.close();
process.chdir(previousDir);
fs.rmSync(workDir, { recursive: true, force: true });
console.log('Smoke test passed: revise feedback, images, vision, traces, gallery pages, comments, views, critic, surveys, and export.');
