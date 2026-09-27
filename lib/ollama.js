import { config } from '../config.js';

export function actionSchema(capabilities = []) { return {
  type: 'object',
  additionalProperties: false,
  required: ['type', 'reason', 'path', 'title', 'content', 'prompt', 'learning', 'confidence', 'confidence_reason'],
  properties: {
    type: {
      type: 'string',
      enum: ['list', 'read', 'write', 'publish', 'revise', 'comment', 'idle',
        ...(capabilities.includes('image_generation') ? ['generate_image'] : []),
        ...(capabilities.includes('image_vision') ? ['inspect_image'] : [])]
    },
    reason: {
      type: 'string',
      description: 'A short private explanation of why this action advances the charge.'
    },
    path: {
      type: ['string', 'null'],
      description: 'For list/read/write/revise/comment/inspect_image. Write paths must begin /shared/. Revise/comment/inspect_image must identify exact existing artwork paths.'
    },
    title: {
      type: ['string', 'null'],
      description: 'For publish and generate_image, the actual nonempty title. For other actions use null.'
    },
    content: {
      type: ['string', 'null'],
      description: 'For write, publish, and revise, the complete nonempty text that should be saved, not a plan. For comment, the comment itself. For other actions use null.'
    },
    prompt: { type: ['string', 'null'], description: 'For generate_image only: nonempty visual description used to create and save an image artwork. For publish, use null.' },
    learning: {
      type: 'string',
      description: 'A concise, evolving understanding of what makes art matter, grounded in this turn’s work and interactions; say what this turn adds, revises, or leaves uncertain.'
    },
    confidence: {
      type: 'integer',
      minimum: 1,
      maximum: 10,
      description: 'Your updated belief in your private orientation, 1 (barely) to 10 (unshakable), after weighing responses to your work and what you found in others’ work.'
    },
    confidence_reason: {
      type: 'string',
      description: 'One sentence naming the specific interaction that moved your confidence, or why nothing did.'
    }
  }
}; }

export const orientationReviewSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['orientation', 'confidence', 'reason'],
  properties: {
    orientation: {
      type: 'string',
      maxLength: 2000,
      description: 'The revised private orientation, or the exact current orientation if the evidence does not warrant changing it.'
    },
    confidence: {
      type: 'integer',
      minimum: 1,
      maximum: 10,
      description: 'How strongly you believe in the returned orientation, from 1 (barely) to 10 (unshakable). Reserve 9–10 for an orientation that has survived real challenge.'
    },
    reason: {
      type: 'string',
      description: 'A concise explanation grounded in the reviewed work, interactions, and shared understanding.'
    }
  }
};

export const criticSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['comment'],
  properties: {
    comment: {
      type: 'string',
      description: 'Your critique of the work, 2 to 5 sentences, specific to this work.'
    }
  }
};

export const criticSurveySchema = {
  type: 'object',
  additionalProperties: false,
  required: ['survey', 'originality', 'stale_patterns', 'standouts'],
  properties: {
    survey: {
      type: 'string',
      description: 'Your survey of the recent works as a whole, 1 to 3 short paragraphs: is anything original happening, and what is being repeated?'
    },
    originality: {
      type: 'integer',
      minimum: 1,
      maximum: 10,
      description: 'How original the recent body of work is as a whole, 1 (one template repeated) to 10 (each work finds its own form).'
    },
    stale_patterns: {
      type: 'array',
      maxItems: 5,
      items: { type: 'string' },
      description: 'Specific templates, phrasings, themes, or moves that have become habits across works.'
    },
    standouts: {
      type: 'array',
      maxItems: 3,
      items: { type: 'string' },
      description: 'Exact paths of works that genuinely break from those patterns; empty if none do.'
    }
  }
};

export async function listOllamaModels() {
  const response = await fetch(`${config.ollamaBaseUrl}/api/tags`);
  if (!response.ok) throw new Error(`Ollama returned ${response.status}`);
  const data = await response.json();
  return (data.models || []).map(model => model.name);
}

export async function askOllama({ model, messages, capabilities = [], think = config.captureThinking,
  format = actionSchema(capabilities) }) {
  const started = Date.now();
  const request = (think) => fetch(`${config.ollamaBaseUrl}/api/chat`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model,
      messages,
      format,
      think,
      stream: false,
      options: {
        temperature: 0.8
      }
    })
  });
  let response = await request(think);
  if (!response.ok && response.status === 400) {
    const detail = await response.text();
    if (think && /think(ing)?.*(not supported|unsupported)|does not support think/i.test(detail)) {
      response = await request(false);
    } else {
      throw new Error(`Ollama ${response.status}: ${detail}`);
    }
  }

  if (!response.ok) {
    const detail = await response.text();
    throw new Error(`Ollama ${response.status}: ${detail}`);
  }

  const data = await response.json();
  let parsed = null;
  let parseError = null;
  try {
    parsed = JSON.parse(data.message?.content || '');
  } catch {
    parseError = 'Model did not return a parseable JSON action.';
  }

  return {
    action: parsed,
    parseError,
    thinking: data.message?.thinking || '',
    rawResponse: data.message?.content || '',
    promptTokens: data.prompt_eval_count || 0,
    completionTokens: data.eval_count || 0,
    durationMs: Date.now() - started
  };
}

export async function inspectImage(model, bytes, question) {
  const response = await fetch(`${config.ollamaBaseUrl}/api/chat`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ model, stream: false, think: false,
      messages: [{ role: 'user', content: question, images: [bytes.toString('base64')] }] })
  });
  if (!response.ok) throw new Error(`Vision model failed (Ollama ${response.status}): ${(await response.text()).slice(0, 400)}`);
  const data = await response.json();
  if (!data.message?.content) throw new Error('Vision model returned no description.');
  return { content: data.message.content, promptTokens: data.prompt_eval_count || 0,
    completionTokens: data.eval_count || 0 };
}
