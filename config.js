import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const pipxMflux = path.join(os.homedir(), '.local', 'bin', 'mflux-generate-z-image-turbo');

export const config = {
  port: Number(process.env.PORT || 3000),
  host: process.env.HOST || '127.0.0.1',
  ollamaBaseUrl: process.env.OLLAMA_BASE_URL || 'http://127.0.0.1:11434',
  defaultModel: process.env.OLLAMA_MODEL || 'qwen3.5:9b',
  captureThinking: process.env.OLLAMA_THINK !== 'false',
  imageModel: 'mflux z-image-turbo',
  mflux: {
    // npm may start without ~/.local/bin on PATH, so prefer the pipx install location when present.
    command: process.env.MFLUX_COMMAND || (fs.existsSync(pipxMflux) ? pipxMflux : 'mflux-generate-z-image-turbo'),
    steps: Number(process.env.MFLUX_STEPS || 9),
    width: Number(process.env.MFLUX_WIDTH || 1024),
    height: Number(process.env.MFLUX_HEIGHT || 1024),
    quantize: process.env.MFLUX_QUANTIZE === 'none' ? null : Number(process.env.MFLUX_QUANTIZE || 8),
    // The first run downloads the model weights, which can take a long time.
    timeoutMs: Number(process.env.MFLUX_TIMEOUT_MS || 30 * 60 * 1000)
  },
  visionModel: process.env.OLLAMA_VISION_MODEL || 'qwen3-vl:30b',
  maxImageBytes: 20 * 1024 * 1024,
  charge: process.env.AGENT_CHARGE || 'Create art that matters.',
  maxVisibleObjects: Number(process.env.MAX_VISIBLE_OBJECTS || 30),
  maxAgentVisibleObjects: Number(process.env.MAX_AGENT_VISIBLE_OBJECTS || 8),
  agentIncludeReflections: process.env.AGENT_INCLUDE_REFLECTIONS === 'true',
  // Chance (0–1) that the critic comments on a random recent work after each artist turn.
  criticProbability: Math.min(1, Math.max(0, Number(process.env.CRITIC_PROBABILITY ?? 0.25) || 0)),
  // When the critic appears and at least this many artworks are new since its last survey, it surveys instead.
  criticSurveyEvery: Math.max(1, Number(process.env.CRITIC_SURVEY_EVERY) || 10),
  maxMemoryItems: Number(process.env.MAX_MEMORY_ITEMS || 12),
  maxContentChars: Number(process.env.MAX_CONTENT_CHARS || 12000)
};
