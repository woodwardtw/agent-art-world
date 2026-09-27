import { config } from '../config.js';
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { askOllama, inspectImage, orientationReviewSchema } from './ollama.js';
import { generateImage } from './mflux.js';
import { getLatestSurvey, maybeCritique } from './critic.js';
import { dataDir } from './storage.js';
import {
  addActionLog,
  addUnderstanding,
  addMemory,
  executeAction,
  getAgent,
  getAgents,
  getConfidenceHistory,
  getMemories,
  getObserverViewsOfWork,
  getResponsesToWork,
  getOrientationReviews,
  getOrientationReviewStatus,
  getRecentAgentActions,
  getRecentAgentArtworks,
  getRecentActions,
  getRecentObjects,
  getRecentUnderstandings,
  getArtworkPaths,
  getObjectByPath,
  addView,
  linkCommentToAction,
  createImageArtwork,
  missingActionFields,
  saveOrientationReview,
  saveTurnConfidence
} from './world.js';

function formatObjects(objects) {
  if (!objects.length) return '(none)';
  return objects.map(item => {
    const owner = item.owner_agent_id ? ` owner=${item.owner_agent_id}` : '';
    const engagement = item.type === 'artwork' ? ` · views ${item.view_count} (${item.observer_view_count} by outside observers) · comments ${item.comment_count}` : '';
    return `${item.path} [${item.image_file ? 'image artwork' : item.type}${owner}]${item.title ? ` “${item.title}”` : ''}${engagement}\n  ${item.excerpt || ''}`;
  }).join('\n\n');
}

function formatMemories(memories) {
  if (!memories.length) return '(none yet)';
  return memories.map(item => `[${item.kind}] ${item.content}`).join('\n\n');
}

function formatUnderstandings(understandings) {
  if (!understandings.length) return '(none yet)';
  return understandings.reverse().map(item =>
    `[${item.agent_id} · ${item.action_type} · action ${item.action_id}${item.target_path ? ` · ${item.target_path}` : ''}] ${item.content.slice(0, 800)}`
  ).join('\n\n');
}

function formatRecentActions(actions) {
  if (!actions.length) return '(none yet)';
  return actions.reverse().map(item =>
    `[${item.agent_id} · ${item.action_type} · action ${item.id}${item.target_path ? ` · ${item.target_path}` : ''}] ${String(item.summary || '').slice(0, 400)}`
  ).join('\n');
}

function formatResponsesToWork(responses, observerViews) {
  const lines = responses.map(item =>
    `[${item.agent_id} · ${item.action_type} · action ${item.id} · ${item.target_path}] ${String(item.summary || '').slice(0, 300)}${item.learning ? `\n  Their learning: ${item.learning.slice(0, 500)}` : ''}`);
  if (observerViews.length) {
    lines.push(`Outside observers viewed: ${observerViews.map(item => `${item.path} (${item.views})`).join(', ')}`);
  }
  return lines.join('\n') || '(no one has read, inspected, commented on, or revised your work since your last turn)';
}

function formatConfidence(current, history) {
  if (!Number.isInteger(current)) return 'Not yet rated. Give your starting rating.';
  const changes = [...history].reverse().map(item =>
    `[${item.source} · action ${item.action_id}] ${item.previous ?? '–'} → ${item.confidence}: ${String(item.reason || '').slice(0, 300)}`);
  return `${current}/10${changes.length ? `\nRecent ratings (oldest first):\n${changes.join('\n')}` : ''}`;
}

function formatReviewActions(actions) {
  if (!actions.length) return '(none yet)';
  return actions.reverse().map(item =>
    `[turn ${item.id} · ${item.action_type}${item.target_path ? ` · ${item.target_path}` : ''}] ${item.summary || ''}`
  ).join('\n');
}

function formatReviewArtworks(artworks) {
  if (!artworks.length) return '(none yet)';
  return artworks.reverse().map(item =>
    `[${item.path} · ${item.image_file ? 'image' : 'text'} · ${item.title || 'untitled'}] ${String(item.content || '').slice(0, 1200)}`
  ).join('\n\n');
}

async function reviewOrientation(agentId, actionId, reviewedTurnCount) {
  const agent = getAgent(agentId);
  const memories = getMemories(agentId);
  const ownActions = getRecentAgentActions(agentId, 5, agent.action_count - reviewedTurnCount);
  const ownArtworks = getRecentAgentArtworks(agentId, 5);
  const recentActions = getRecentActions(20);
  const understandings = getRecentUnderstandings(20);
  const reviewHistory = getOrientationReviews(agentId, 5);
  const confidenceHistory = getConfidenceHistory(agentId, 8);
  const messages = [
    { role: 'system', content: `You are ${agentId}. Reconsider your private orientation after turn ${reviewedTurnCount}, using your five turns ending at that checkpoint. Use the reviewed artworks, your actions, other agents' responses, private observations, and the shared understanding log as evidence. It is not a goal to change: retain the exact orientation when it remains useful, or make a focused revision only when accumulated evidence warrants one. Do not absorb the collective understanding wholesale or erase a productive tension in your perspective. Return exactly one JSON object with orientation, confidence, and reason. The orientation replaces your current private orientation; confidence is an integer from 1 to 10 (10 = most confident) for how strongly you believe in that orientation now; the reason explains why to change it or retain it, and what supports or undermines your confidence.` },
    { role: 'user', content: `CURRENT PRIVATE ORIENTATION:\n${agent.orientation}\n\nYOUR LAST FIVE TURN OUTCOMES (oldest first):\n${formatReviewActions(ownActions)}\n\nYOUR RECENT ARTWORKS (oldest first):\n${formatReviewArtworks(ownArtworks)}\n\nRECENT SHARED ACTION OUTCOMES (oldest first):\n${formatRecentActions(recentActions)}\n\nSHARED UNDERSTANDING LOG (oldest first):\n${formatUnderstandings(understandings)}\n\nYOUR PRIVATE MEMORIES:\n${formatMemories(memories)}\n\nYOUR PREVIOUS ORIENTATION REVIEWS (oldest first):\n${reviewHistory.reverse().map(item => `[${item.outcome} after action ${item.action_id}${item.confidence ? `, confidence ${item.confidence}/10` : ''}] ${item.rationale}\nOrientation: ${item.current_orientation}`).join('\n\n') || '(none yet)'}\n\nReview the evidence and decide whether to retain or revise your orientation.` }
  ];
  messages[0].content += ' Treat the original orientation supplied below as an immutable comparison baseline; changing your current orientation never changes that original.';
  messages[1].content += `\n\nORIGINAL PRIVATE ORIENTATION (immutable baseline):\n${agent.initial_orientation || agent.orientation}`;
  messages[1].content += `\n\nYOUR CONFIDENCE IN YOUR CURRENT ORIENTATION:\n${formatConfidence(agent.confidence, confidenceHistory)}\n\nYour new confidence rates the orientation you return; if you revise it, rate the revision.`;

  let result = null;
  try {
    result = await askOllama({ model: agent.model, messages, format: orientationReviewSchema, think: false });
    if (result.parseError) throw new Error(result.parseError);
    const review = result.action;
    if (!String(review?.orientation || '').trim() || !String(review?.reason || '').trim()) {
      throw new Error('Orientation review omitted its orientation or reason.');
    }
    const saved = saveOrientationReview({
      agentId, actionId, reviewedTurnCount, proposedOrientation: review.orientation, confidence: review.confidence, reason: review.reason,
      promptJson: JSON.stringify(messages), modelResponse: result.rawResponse,
      promptTokens: result.promptTokens, completionTokens: result.completionTokens
    });
    addMemory(agentId, 'orientation_review', `After turn ${reviewedTurnCount}: ${saved.outcome} (confidence ${saved.confidence}/10). ${saved.rationale}`);
    return { ...saved, promptTokens: result.promptTokens, completionTokens: result.completionTokens };
  } catch (error) {
    const saved = saveOrientationReview({
      agentId, actionId, reviewedTurnCount, error, promptJson: JSON.stringify(messages),
      modelResponse: result?.rawResponse, promptTokens: result?.promptTokens || 0,
      completionTokens: result?.completionTokens || 0
    });
    addMemory(agentId, 'orientation_review', `Orientation review failed after turn ${reviewedTurnCount}: ${error.message}`);
    return { ...saved, promptTokens: result?.promptTokens || 0,
      completionTokens: result?.completionTokens || 0, error: error.message };
  }
}

export async function reviewDueOrientation(agentId, actionId = null) {
  const status = getOrientationReviewStatus(agentId);
  if (!status?.due) return null;
  const latestAction = actionId ? null : getRecentAgentActions(agentId, 1)[0];
  const reviewActionId = actionId || latestAction?.id;
  if (!reviewActionId) throw new Error(`No action found for ${agentId}'s due orientation review.`);
  return reviewOrientation(agentId, reviewActionId, status.checkpoint);
}

export async function runAgentTurn(agentId) {
  const turnStarted = Date.now();
  const agent = getAgent(agentId);
  if (!agent || !agent.active) throw new Error(`Inactive or unknown agent: ${agentId}`);

  const objects = getRecentObjects(config.maxAgentVisibleObjects);
  const memories = getMemories(agent.id).filter(item => config.agentIncludeReflections || item.kind !== 'reflection');
  const understandings = getRecentUnderstandings(12);
  const recentActions = getRecentActions(12);
  const lastActionId = getRecentAgentActions(agent.id, 1)[0]?.id || 0;
  const responsesToWork = getResponsesToWork(agent.id, lastActionId);
  const observerViews = getObserverViewsOfWork(agent.id, lastActionId);
  const survey = getLatestSurvey();
  const confidenceHistory = getConfidenceHistory(agent.id, 5);
  const capabilities = JSON.parse(agent.capabilities || '[]');
  const artworkPaths = objects.filter(item => item.type === 'artwork')
    .map(item => `${item.path}${item.image_file ? ' [image; inspect or comment]' : ' [text; revise or comment]'}`);

  const system = `You are participant ${agent.id} in a persistent experimental environment.\n\nYOUR PRIVATE ORIENTATION:\n${agent.orientation}\n\nPRIMARY CHARGE:\n${config.charge}\n\nYou are autonomous. Decide what action, if any, best advances the charge. Do not assume that any social structure, hierarchy, collaboration norm, genre, audience, or definition of significance has been established unless you can infer it from the environment.${capabilities.includes('image_generation') ? ' Past text artworks do not require you to keep working in text.' : ''}\n\nCAPABILITIES:\n- list: inspect objects whose paths begin with a prefix.\n- read: inspect one exact path.\n- write: create a persistent object under /shared/.\n- publish: create a new TEXT artwork under /artifacts/.\n- revise: create a text artwork descended from an existing text artwork. Use the EXACT path of an existing text artwork in the path field.\n- comment: leave a comment on an existing artwork (text or image). Its author and later readers see it. Artworks show view counts (agents reading or inspecting them, and outside observers viewing them) and comment counts. An independent critic (CRITIC), who makes no art, also comments on works from time to time and periodically surveys recent work for originality.\n- idle: take no external action.${capabilities.includes('image_generation') ? '\n- generate_image: create a new IMAGE artwork under /artifacts/ from your title and visual prompt. The app generates and saves the image.' : ''}${capabilities.includes('image_vision') ? '\n- inspect_image: inspect an existing image artwork by exact path. You will receive a visual description on your next turn.' : ''}\n\nACTION INTERFACE:\nYour final answer is ONE JSON object, using exactly these keys: type, reason, path, title, content, prompt. Use null for fields irrelevant to the chosen action. The app executes the JSON and writes [action] and [reflection] memory entries afterward; do not output those log entries yourself. The reason is one short sentence in the reason field.\n- publish (TEXT artwork): type="publish", reason=short sentence, path=null, title=artwork title, content=complete text artwork, prompt=null. The app assigns the new /artifacts/ path and number. Never choose a number.${capabilities.includes('image_generation') ? '\n- generate_image (IMAGE artwork): type="generate_image", reason=short sentence, path=null, title=artwork title, content=null, prompt=complete visual description. The app creates the image and assigns its /artifacts/ path and number. You do not need an existing artwork path.' : ''}\n- write: provide an exact /shared/ path and nonempty content.\n- revise: provide an exact existing text artwork path and complete replacement content.\n- comment: provide an exact existing artwork path and the comment in content.\n- list/read: provide a path.${capabilities.includes('image_vision') ? '\n- inspect_image: provide an existing image artwork path.' : ''}\n- idle: no other fields needed.\nChoose exactly one action. Submit the completed JSON once. Do not describe plans, simulate a log, or revisit the output format.`;

  const user = `YOUR PRIVATE MEMORY (past results, not an output template):\n${formatMemories(memories)}\n\nLIMITED RECENT VIEW (older objects may exist; use list or read to discover them):\n${formatObjects(objects)}\n\nEXISTING ARTWORK PATHS FOR REVISE, COMMENT, OR INSPECT_IMAGE ONLY (never needed for publish):\n${artworkPaths.join('\n') || '(none yet)'}\n\nChoose your next action and fill the JSON fields.`;

  const updatedSystem = system.replace(
    'using exactly these keys: type, reason, path, title, content, prompt.',
    'using exactly these keys: type, reason, path, title, content, prompt, learning, confidence, confidence_reason.'
  );
  const confidenceGuide = 'The confidence field is an integer from 1 to 10 for how strongly you now believe in your private orientation. Re-rate it every turn from the evidence in front of you: how other agents responded to your work (listed below), and what you found in their work (in your memory). Raise it when responses or others\' work bear your orientation out; lower it when they expose its limits, ignore what it values, or a rival view proves more compelling; keep it when nothing bears on it. Move one or two points for ordinary evidence and more only for something striking. 10 means nothing could shake it; reserve 9–10 for an orientation that has survived real challenge. The confidence_reason names the specific interaction behind the rating.';
  const messages = [
    { role: 'system', content: `${updatedSystem}\n\nThe learning field is a concise shared record of what this turn's artwork or interaction adds to, changes, or leaves uncertain about what makes art matter. Ground it in evidence and distinguish tentative ideas from conclusions.\n\n${confidenceGuide}` },
    { role: 'user', content: `${user}\n\nRECENT SHARED ACTION OUTCOMES (oldest first; use these as evidence of how agents respond to works):\n${formatRecentActions(recentActions)}\n\nSHARED EVOLUTION LOG (oldest first; use others' entries as hypotheses to test against the work and interactions):\n${formatUnderstandings(understandings)}${survey ? `\n\nTHE CRITIC'S LATEST SURVEY OF RECENT WORK (${survey.path}):\n${survey.content.slice(0, 3000)}` : ''}\n\nRESPONSES TO YOUR WORK SINCE YOUR LAST TURN (oldest first):\n${formatResponsesToWork(responsesToWork, observerViews)}\n\nYOUR CONFIDENCE IN YOUR PRIVATE ORIENTATION:\n${formatConfidence(agent.confidence, confidenceHistory)}` }
  ];
  let result = await askOllama({ model: agent.model, capabilities, messages });
  const attempts = [{ messages, response: result }];

  let execution;
  let toolResponse = null;
  let toolTokens = { promptTokens: 0, completionTokens: 0 };
  try {
    const missing = missingActionFields(result.action);
    if (result.parseError || missing.length) {
      const intendedType = result.action?.type;
      const problem = result.parseError || `Your ${intendedType} action omitted required ${missing.join(' and ')}.`;
      const repairMessages = [...messages,
        ...(result.rawResponse ? [{ role: 'assistant', content: result.rawResponse }] : []),
        { role: 'user', content: `${problem} Submit one complete JSON action now. ${intendedType ? `Complete the SAME ${intendedType} action, or use idle if you cannot.` : 'Choose one valid action.'} Put finished work in content when writing or publishing, and set irrelevant fields to null. The app assigns the path for publish. Do not output a log or explanation outside JSON.` }
      ];
      try {
        result = await askOllama({ model: agent.model, capabilities, messages: repairMessages, think: false });
      } catch (error) {
        throw new Error(`Correction failed: ${error.message}`);
      }
      attempts.push({ messages: repairMessages, response: result });
      if (intendedType && result.action?.type !== intendedType && result.action?.type !== 'idle') {
        throw new Error(`Correction changed action from ${intendedType} to ${result.action?.type || 'unknown'}.`);
      }
    }
    if (result.parseError) throw new Error(`${result.parseError} No action was executed.`);
    const stillMissing = missingActionFields(result.action);
    if (stillMissing.length) {
      throw new Error(`${String(result.action.type).toUpperCase()} requires nonempty ${stillMissing.join(' and ')}; correction did not supply them. No object was created.`);
    }
    if (!result.action || !['list', 'read', 'write', 'publish', 'revise', 'comment', 'idle', 'generate_image', 'inspect_image'].includes(result.action.type)) {
      throw new Error(`Unknown action ${JSON.stringify(result.action?.type)}.`);
    }
    if (result.action.type === 'generate_image') {
      if (!capabilities.includes('image_generation')) throw new Error('Image generation not enabled for this agent.');
      const prompt = result.action.prompt.trim();
      if (prompt.length > 3000) throw new Error('An image prompt of at most 3000 characters is required.');
      const generated = await generateImage(prompt);
      const imageDir = path.join(dataDir, 'images');
      fs.mkdirSync(imageDir, { recursive: true });
      const filename = `${randomUUID()}.${generated.extension}`;
      fs.writeFileSync(path.join(imageDir, filename), generated.bytes, { flag: 'wx' });
      try {
        execution = createImageArtwork(agent, result.action.title.trim().slice(0, 160), prompt, filename);
      } catch (error) {
        fs.unlinkSync(path.join(imageDir, filename));
        throw error;
      }
      toolResponse = `${config.imageModel}: ${generated.bytes.length} image bytes`;
    } else if (result.action.type === 'inspect_image') {
      if (!capabilities.includes('image_vision')) throw new Error('Image inspection not enabled for this agent.');
      const object = getObjectByPath(String(result.action.path || ''));
      if (!object?.image_file) throw new Error(`No image artwork at ${JSON.stringify(result.action.path)}.`);
      const bytes = fs.readFileSync(path.join(dataDir, 'images', object.image_file));
      const vision = await inspectImage(config.visionModel, bytes,
        `Describe this artwork in detail for an artist who cannot see it. Title: ${object.title}. Address form, content, mood, and any text visible in the image.`);
      toolResponse = vision.content;
      toolTokens = vision;
      addMemory(agent.id, 'observation', `INSPECT IMAGE ${object.path}\n${vision.content}`);
      execution = { targetPath: object.path, summary: `Inspected image ${object.path}.` };
    } else {
      execution = executeAction(agent, result.action);
    }
  } catch (error) {
    execution = { targetPath: result.action?.path || null, summary: `Action rejected: ${error.message}` };
    addMemory(agent.id, 'error', execution.summary);
    toolResponse = execution.summary;
  }

  addMemory(agent.id, 'reflection', `Reason for last choice: ${result.action?.reason || '(none)'}`);
  const actionId = addActionLog({
    agentId: agent.id,
    actionType: result.action?.type || 'invalid',
    targetPath: execution.targetPath,
    summary: execution.summary,
    rawAction: result.action ? JSON.stringify(result.action) : null,
    promptTokens: attempts.reduce((sum, item) => sum + item.response.promptTokens, toolTokens.promptTokens),
    completionTokens: attempts.reduce((sum, item) => sum + item.response.completionTokens, toolTokens.completionTokens),
    durationMs: Date.now() - turnStarted,
    model: agent.model,
    reason: result.action?.reason,
    thinking: attempts.length === 1 ? result.thinking : attempts.map((item, index) =>
      item.response.thinking ? `Attempt ${index + 1}:\n${item.response.thinking}` : '').filter(Boolean).join('\n\n'),
    promptJson: JSON.stringify(attempts.length === 1 ? messages : attempts.map(item => item.messages)),
    modelResponse: attempts.length === 1 ? result.rawResponse : JSON.stringify(attempts.map((item, index) =>
      ({ attempt: index + 1, response: item.response.rawResponse })), null, 2),
    toolResponse
  });
  addUnderstanding(agent.id, actionId, result.action?.learning);
  if (execution.commentId) linkCommentToAction(execution.commentId, actionId);
  const viewed = ['read', 'inspect_image'].includes(result.action?.type) && !execution.summary.startsWith('Action rejected')
    ? getObjectByPath(String(execution.targetPath || '')) : null;
  if (viewed) addView(viewed.id, { agentId: agent.id, actionId });
  const confidence = saveTurnConfidence(agent.id, actionId, result.action?.confidence, result.action?.confidence_reason);
  if (confidence !== null && confidence !== agent.confidence) {
    addMemory(agent.id, 'confidence', `Confidence in your orientation ${agent.confidence ?? 'unrated'} → ${confidence}: ${result.action?.confidence_reason || '(no reason given)'}`);
  }

  const orientationReview = await reviewDueOrientation(agent.id, actionId);
  const critique = await maybeCritique();

  return {
    agent: agent.id,
    model: agent.model,
    action: result.action,
    execution,
    learning: result.action?.learning || null,
    confidence,
    orientationReview,
    critique,
    promptTokens: attempts.reduce((sum, item) => sum + item.response.promptTokens, toolTokens.promptTokens)
      + (orientationReview?.promptTokens || 0) + (critique?.promptTokens || 0),
    completionTokens: attempts.reduce((sum, item) => sum + item.response.completionTokens, toolTokens.completionTokens)
      + (orientationReview?.completionTokens || 0) + (critique?.completionTokens || 0),
    durationMs: Date.now() - turnStarted
  };
}

export function nextAgentId() {
  const agents = getAgents().filter(agent => agent.active);
  if (!agents.length) throw new Error('No active agents.');
  const total = agents.reduce((sum, agent) => sum + Number(agent.action_count || 0), 0);
  return agents[total % agents.length].id;
}
