const state = {
  running: false,
  testingImage: false,
  stopRequested: false,
  pages: { actions: 0, objects: 0, understandings: 0, gallery: 0 },
  models: []
};

const el = id => document.getElementById(id);
const esc = value => String(value ?? '').replace(/[&<>'"]/g, char => ({
  '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;'
}[char]));

async function jsonFetch(url, options = {}) {
  const response = await fetch(url, {
    headers: { 'Content-Type': 'application/json', ...(options.headers || {}) },
    ...options
  });
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || `HTTP ${response.status}`);
  return data;
}

function setStatus(message, kind = 'light') {
  const node = el('liveStatus');
  node.className = `alert alert-${kind} border`;
  node.textContent = message;
}

function renderPager(key, { page, pageSize, total }, noun) {
  state.pages[key] = page; // the server clamps pages that no longer exist
  const pages = Math.max(1, Math.ceil(total / pageSize));
  const count = el(`${key}Count`);
  if (count) count.textContent = `${total} ${noun}${total === 1 ? '' : 's'} · newest first`;
  el(`${key}Pager`).innerHTML = pages === 1 ? '' : `
    <button type="button" class="btn btn-outline-secondary btn-sm" data-pager="${key}" data-step="-1"${page === 0 ? ' disabled' : ''}>Previous</button>
    <span class="pager-label" aria-live="polite">Page ${page + 1} of ${pages}</span>
    <button type="button" class="btn btn-outline-secondary btn-sm" data-pager="${key}" data-step="1"${page + 1 >= pages ? ' disabled' : ''}>Next</button>`;
}

async function refresh() {
  const [status, agents, actions, objects, gallery, understandings] = await Promise.all([
    jsonFetch('/api/status'),
    jsonFetch('/api/agents'),
    jsonFetch(`/api/actions?page=${state.pages.actions}`),
    jsonFetch(`/api/objects?page=${state.pages.objects}`),
    jsonFetch(`/api/artworks?page=${state.pages.gallery}`),
    jsonFetch(`/api/understandings?page=${state.pages.understandings}`)
  ]);

  state.models = status.ollama.models || [];
  state.criticProbability = status.criticProbability;
  state.criticSurveyEvery = status.criticSurveyEvery;
  el('toolModels').textContent = `Thinking output: ${status.captureThinking ? 'requested' : 'off'} · Agent recent view: ${status.agentVisibleObjects} objects · Reflection feedback: ${status.agentIncludeReflections ? 'on' : 'off'} · Image model: ${status.imageModel} · Vision model: ${status.visionModel}.`;
  el('charge').textContent = `Charge: “${status.charge}”`;
  el('ollamaStatus').textContent = status.ollama.ok
    ? `Ollama connected · ${state.models.length} model${state.models.length === 1 ? '' : 's'}`
    : `Ollama unavailable`;
  const databasePath = status.databasePath || (status.dataDir ? `${status.dataDir}/world.sqlite` : '');
  const storageNotice = el('storageNotice');
  storageNotice.textContent = status.migratedFrom
    ? `Previous experiment loaded from ${status.migratedFrom}. Database: ${databasePath}.`
    : status.stats.actions === 0
      ? `New or empty experiment. Database: ${databasePath || 'unknown (restart the server from the updated folder)'}. To recover earlier work, stop the server and run: npm run migrate -- "/path/to/old/agent-art-world/data".`
      : `Database: ${databasePath || 'unknown (restart the server from the updated folder)'}`;
  el('copyDatabasePath').hidden = !databasePath;
  el('copyDatabasePath').dataset.path = databasePath;

  el('statActions').textContent = status.stats.actions;
  el('statArtworks').textContent = status.stats.artworks;
  el('statShared').textContent = status.stats.shared_objects;
  el('statTokens').textContent = Number(status.stats.prompt_tokens + status.stats.completion_tokens).toLocaleString();

  const image = status.imageActivity;
  const imageAgents = agents.filter(agent => JSON.parse(agent.capabilities || '[]').includes('image_generation'))
    .map(agent => agent.id);
  el('imageActivity').textContent = !image
    ? 'Image activity is unavailable until the server is restarted from the updated application folder.'
    : image.attempts === 0
      ? `Images: none attempted yet. Generation is enabled for ${imageAgents.join(', ') || 'no agents'}; agents choose their own actions.`
      : `Images: ${image.created} created from ${image.attempts} attempt${image.attempts === 1 ? '' : 's'}. Latest: ${image.lastAttempt?.agent_id || 'unknown'} — ${image.lastAttempt?.summary || 'No result recorded'}`;

  renderAgents(agents);
  const selectedAgent = el('turnAgent').value;
  el('turnAgent').innerHTML = '<option value="">Next agent</option>' + agents
    .filter(agent => agent.active)
    .map(agent => `<option value="${esc(agent.id)}">${esc(agent.id)}</option>`).join('');
  el('turnAgent').value = selectedAgent;
  renderActions(actions);
  renderObjects(objects);
  renderUnderstandings(understandings);
  renderGallery(gallery);
  if (!image) setStatus('The dashboard and server are different versions. Stop the old server, start this updated folder, then reload the page.', 'warning');
}

function modelOptions(agent) {
  return [...new Set([agent.model, ...state.models])]
    .map(model => `<option value="${esc(model)}"${model === agent.model ? ' selected' : ''}>${esc(model)}</option>`)
    .join('');
}

function renderCritic(critic) {
  const id = esc(critic.id);
  const inspects = JSON.parse(critic.capabilities || '[]').includes('image_vision');
  const chance = Math.round((state.criticProbability ?? 0) * 100);
  return `
    <section class="card agent-card border-secondary-subtle" aria-labelledby="agent-${id}">
      <div class="card-body">
        <div class="d-flex flex-wrap align-items-center gap-2">
          <h3 class="h6 mb-0 me-auto" id="agent-${id}">Critic</h3>
          <span class="badge text-bg-light border" title="Chance the critic appears after each turn. It surveys recent work once ${state.criticSurveyEvery} new works have appeared since its last survey; otherwise it comments on one work.">After ${chance}% of turns</span>
          <span class="badge text-bg-secondary">${critic.action_count} critique${critic.action_count === 1 ? '' : 's'}</span>
        </div>
        <div class="d-flex flex-wrap align-items-center gap-2 mt-1">
          <label class="visually-hidden" for="model-${id}">Model for the critic</label>
          <select class="form-select form-select-sm agent-model" id="model-${id}" data-agent="${id}">${modelOptions(critic)}</select>
          <div class="form-check form-check-inline small mb-0 me-0"><input class="form-check-input agent-capability" type="checkbox" data-agent="${id}" value="image_vision" id="vision-${id}" ${inspects ? 'checked' : ''}><label class="form-check-label" for="vision-${id}">Inspect</label></div>
          <button class="btn btn-sm btn-outline-primary py-0 critic-now" data-endpoint="critique" type="button"${state.running ? ' disabled' : ''}>Critique</button>
          <button class="btn btn-sm btn-outline-primary py-0 critic-now" data-endpoint="survey" type="button"${state.running ? ' disabled' : ''}>Survey</button>
        </div>
        <details class="mt-1"><summary>Critical stance</summary><p class="small mt-2 mb-0">${esc(critic.orientation)}</p></details>
      </div>
    </section>`;
}

function renderAgents(allAgents) {
  const agents = allAgents.filter(agent => agent.role !== 'critic');
  const critic = allAgents.find(agent => agent.role === 'critic');
  el('agents').innerHTML = agents.map(agent => {
    const options = modelOptions(agent);
    const capabilities = JSON.parse(agent.capabilities || '[]');
    const orientationReviews = agent.orientation_reviews || [];
    const reviewStatus = agent.orientation_review_status;
    const confidenceHistory = agent.confidence_history || [];
    const latestChange = confidenceHistory.find(item => item.previous !== null && item.previous !== item.confidence);
    const trend = !latestChange ? '' : latestChange.confidence > latestChange.previous
      ? ` <span aria-hidden="true">▲</span><span class="visually-hidden">, up from ${latestChange.previous}</span>`
      : ` <span aria-hidden="true">▼</span><span class="visually-hidden">, down from ${latestChange.previous}</span>`;
    const id = esc(agent.id);
    return `
      <section class="card agent-card" aria-labelledby="agent-${id}">
        <div class="card-body">
          <div class="d-flex flex-wrap align-items-center gap-2">
            <h3 class="h6 mb-0 me-auto" id="agent-${id}">${id}</h3>
            ${agent.confidence ? `<span class="badge text-bg-light border" title="Current confidence in its private orientation${latestChange ? `; last change ${latestChange.previous} → ${latestChange.confidence}` : ''}">Confidence ${agent.confidence}/10${trend}</span>` : ''}
            <span class="badge text-bg-secondary">${agent.action_count} turns</span>
          </div>
          <div class="d-flex flex-wrap align-items-center gap-2 mt-1">
            <label class="visually-hidden" for="model-${id}">Model for ${id}</label>
            <select class="form-select form-select-sm agent-model" id="model-${id}" data-agent="${id}">${options}</select>
            <div class="form-check form-check-inline small mb-0 me-0"><input class="form-check-input agent-capability" type="checkbox" data-agent="${id}" value="image_generation" id="generate-${id}" ${capabilities.includes('image_generation') ? 'checked' : ''}><label class="form-check-label" for="generate-${id}">Generate</label></div>
            <div class="form-check form-check-inline small mb-0 me-0"><input class="form-check-input agent-capability" type="checkbox" data-agent="${id}" value="image_vision" id="vision-${id}" ${capabilities.includes('image_vision') ? 'checked' : ''}><label class="form-check-label" for="vision-${id}">Inspect</label></div>
          </div>
          ${reviewStatus?.due ? `<button class="btn btn-sm btn-outline-primary orientation-review mt-1 py-0" type="button" data-agent="${id}">Review orientation through turn ${reviewStatus.checkpoint}</button>` : ''}
          <details class="mt-1"><summary>Private orientation · ${orientationReviews.length} review${orientationReviews.length === 1 ? '' : 's'}</summary>
            <p class="small mt-2"><strong>Original:</strong> ${esc(agent.initial_orientation || agent.orientation)}</p>
            <p class="small"><strong>Current:</strong> ${esc(agent.orientation)}</p>
            <p class="small fw-semibold mb-1">Confidence history</p>
            <ol class="list-unstyled small border-top mb-2">${confidenceHistory.map(item => `
              <li class="py-1 border-bottom"><strong>${item.previous ?? '–'} → ${item.confidence}</strong> · ${esc(item.source)} · action #${item.action_id}<div>${esc(item.reason || '')}</div></li>`).join('')
              || '<li class="py-1 text-body-secondary">No ratings yet.</li>'}</ol>
            <p class="small fw-semibold mb-1">Orientation reviews</p>
            <ol class="list-unstyled border-top mb-0">${orientationReviews.map(review => `
              <li class="py-2 border-bottom">
                <div class="small"><strong>${esc(review.outcome)}</strong>${review.confidence ? ` · confidence ${review.confidence}/10` : ''} · turn ${review.reviewed_turn_count} · action #${review.action_id} · ${esc(review.created_at)}</div>
                <p class="small mb-1">${esc(review.rationale)}</p>
                ${review.outcome === 'changed' ? `<p class="small mb-0"><strong>Updated orientation:</strong> ${esc(review.current_orientation)}</p>` : ''}
              </li>`).join('') || '<li class="py-2 small text-body-secondary">No five-turn reviews yet.</li>'}</ol>
          </details>
        </div>
      </section>`;
  }).join('') + (critic ? renderCritic(critic) : '');

  document.querySelectorAll('.critic-now').forEach(button => button.addEventListener('click', async event => {
    const { endpoint } = event.currentTarget.dataset;
    document.querySelectorAll('.critic-now').forEach(node => { node.disabled = true; });
    setStatus(endpoint === 'survey' ? 'The critic is surveying recent work…' : 'The critic is choosing a work…');
    try {
      const result = await jsonFetch(`/api/critic/${endpoint}`, { method: 'POST' });
      setStatus(result.summary, result.error ? 'danger' : 'success');
      await refresh();
    } catch (error) {
      setStatus(error.message, 'danger');
      document.querySelectorAll('.critic-now').forEach(node => { node.disabled = false; });
    }
  }));

  document.querySelectorAll('.agent-model').forEach(select => {
    select.addEventListener('change', async event => {
      const agentId = event.target.dataset.agent;
      await jsonFetch(`/api/agents/${encodeURIComponent(agentId)}/model`, {
        method: 'POST',
        body: JSON.stringify({ model: event.target.value })
      });
      setStatus(`${agentId} will use ${event.target.value}.`, 'success');
    });
  });
  document.querySelectorAll('.agent-capability').forEach(input => {
    input.addEventListener('change', async event => {
      const agentId = event.target.dataset.agent;
      const capabilities = [...document.querySelectorAll('.agent-capability')]
        .filter(node => node.dataset.agent === agentId && node.checked).map(node => node.value);
      try {
        await jsonFetch(`/api/agents/${encodeURIComponent(agentId)}/capabilities`, {
          method: 'POST', body: JSON.stringify({ capabilities })
        });
        setStatus(`${agentId} capabilities saved.`, 'success');
      } catch (error) {
        event.target.checked = !event.target.checked;
        setStatus(error.message, 'danger');
      }
    });
  });
  document.querySelectorAll('.orientation-review').forEach(button => {
    button.addEventListener('click', async event => {
      const agentId = event.currentTarget.dataset.agent;
      event.currentTarget.disabled = true;
      setStatus(`Reconsidering ${agentId}'s private orientation…`);
      try {
        const review = await jsonFetch(`/api/agents/${encodeURIComponent(agentId)}/orientation-review`, { method: 'POST' });
        setStatus(`${agentId} ${review.outcome} its orientation after turn ${review.reviewed_turn_count}.`, 'success');
        await refresh();
      } catch (error) {
        setStatus(error.message, 'danger');
        event.currentTarget.disabled = false;
      }
    });
  });
}

function engagementLine(object) {
  if (object.type !== 'artwork') return '';
  const views = Number(object.view_count || 0);
  const comments = Number(object.comment_count || 0);
  return `<span class="d-block small text-body-secondary">${views} view${views === 1 ? '' : 's'} · ${comments} comment${comments === 1 ? '' : 's'}</span>`;
}

function renderActions(page) {
  renderPager('actions', page, 'action');
  el('actionsBody').innerHTML = page.items.map(action => `
    <tr>
      <td>${action.id}</td>
      <td><code>${esc(action.agent_id)}</code></td>
      <td>${esc(action.action_type)}</td>
      <td>${esc(action.summary || '')}</td>
      <td>${Number(action.prompt_tokens + action.completion_tokens).toLocaleString()}</td>
      <td>${(Number(action.duration_ms) / 1000).toFixed(1)}s</td>
      <td><button class="btn btn-sm btn-outline-secondary action-trace" data-id="${action.id}" type="button" aria-label="View trace for action ${action.id}">View</button></td>
    </tr>`).join('') || '<tr><td colspan="7" class="text-body-secondary">No agent actions yet.</td></tr>';
  document.querySelectorAll('.action-trace').forEach(button => {
    button.addEventListener('click', () => showAction(button.dataset.id));
  });
}

async function showAction(id) {
  const action = await jsonFetch(`/api/actions/${encodeURIComponent(id)}`);
  el('actionModalTitle').textContent = `Action #${action.id} · ${action.agent_id} · ${action.action_type}`;
  const sections = [
    ['Result', action.summary], ['Model', action.model],
    ['Stated reason', action.reason || '(none supplied)'],
    ['Ollama thinking output', action.thinking || '(no thinking field returned by this model)'],
    ['Prompt(s) sent to model', action.prompt_json],
    ['Model response(s)', action.model_response],
    ['Tool response', action.tool_response || '(no separate tool response)']
  ];
  const body = el('actionModalBody');
  body.replaceChildren();
  sections.forEach(([label, value]) => {
    const heading = document.createElement('h3');
    heading.className = 'h6 mt-3';
    heading.textContent = label;
    const content = document.createElement('pre');
    content.className = 'object-content border rounded p-2 bg-body-tertiary';
    content.textContent = value || '';
    body.append(heading, content);
  });
  bootstrap.Modal.getOrCreateInstance(el('actionModal')).show();
}

function renderObjects(page) {
  renderPager('objects', page, 'object');
  el('objects').innerHTML = page.items.map(object => `
    <div class="col-12 col-md-6">
      <button class="card object-card text-start w-100 h-100 border-0 shadow-sm" data-path="${esc(object.path)}" type="button">
        <div class="card-body">
          <div class="d-flex justify-content-between gap-2"><span class="badge text-bg-light">${esc(object.type)}</span><small>${esc(object.owner_agent_id || 'world')}</small></div>
          <h3 class="h6 mt-2 mb-1">${esc(object.title || object.path)}</h3>
          ${object.type === 'artwork' && !object.image_file && !String(object.excerpt || '').trim() ? '<span class="badge text-bg-warning mb-2">Empty earlier artwork</span>' : ''}
          ${object.image_file ? '<span class="badge text-bg-info mb-2">Image</span>' : ''}
          <div class="path small text-body-secondary mb-2">${esc(object.path)}</div>
          <p class="small mb-1">${esc(object.excerpt || '')}</p>
          ${engagementLine(object)}
        </div>
      </button>
    </div>`).join('') || '<p class="text-body-secondary">No world objects yet.</p>';

  document.querySelectorAll('#objects .object-card').forEach(button => {
    button.addEventListener('click', () => showObject(button.dataset.path));
  });
}

function renderUnderstandings(page) {
  renderPager('understandings', page, 'documented turn');
  el('understandings').innerHTML = page.items.map(item => `
    <li class="py-3 border-bottom">
      <div class="d-flex flex-wrap gap-2 align-items-baseline mb-1">
        <strong>${esc(item.agent_id)}</strong>
        <span class="small text-body-secondary">${esc(item.action_type)} · action #${item.action_id}${item.target_path ? ` · ${esc(item.target_path)}` : ''} · ${esc(item.created_at)}</span>
      </div>
      <p class="mb-0">${esc(item.content)}</p>
    </li>`).join('') || '<li class="py-3 text-body-secondary">No shared understandings recorded yet.</li>';
}

function renderGallery(page) {
  renderPager('gallery', page, 'published work');
  el('gallery').innerHTML = page.items.map(object => `
    <div class="col-12 col-md-6"><button type="button" class="card object-card text-start w-100 h-100 border-0 shadow-sm" data-path="${esc(object.path)}">
      <span class="card-body">
        <span class="small text-body-secondary">${esc(object.owner_agent_id || 'unknown')} · ${esc(object.created_at || '')}</span>
        <span class="d-block h6 mt-2">${esc(object.title || object.path)}</span>
        ${object.image_file ? '<span class="badge text-bg-info">Image</span>' : ''}
        ${!object.image_file && !String(object.excerpt || '').trim() ? '<span class="badge text-bg-warning">Empty earlier artwork</span>' : ''}
        <span class="d-block small path text-body-secondary">${esc(object.path)}</span>
        <span class="d-block small mt-2">${esc(object.excerpt || '')}</span>
        ${engagementLine(object)}
      </span></button></div>`).join('') || '<p class="text-body-secondary">No artworks yet.</p>';
  document.querySelectorAll('#gallery .object-card').forEach(button => {
    button.addEventListener('click', () => showObject(button.dataset.path));
  });
}

async function showObject(path) {
  const object = await jsonFetch(`/api/object?path=${encodeURIComponent(path)}`);
  el('objectModalTitle').textContent = object.title || object.path;
  el('objectModalContent').textContent = `${object.path}\n${object.owner_agent_id ? `Created by ${object.owner_agent_id}\n` : ''}\n${object.content}`;
  const image = el('objectModalImage');
  image.classList.toggle('d-none', !object.image_file);
  image.src = object.image_file ? `/api/objects/${object.id}/image?path=${encodeURIComponent(object.path)}` : '';
  image.alt = object.image_file ? `Generated image, titled ${object.title || 'Untitled'}. Generation prompt: ${object.content}` : '';
  el('objectModalEngagement').hidden = true;
  bootstrap.Modal.getOrCreateInstance(el('objectModal')).show();
  if (object.type !== 'artwork') return;
  const engagement = await jsonFetch(`/api/objects/${object.id}/view`, { method: 'POST' });
  el('objectModalViews').textContent = `${engagement.views} view${engagement.views === 1 ? '' : 's'} (${engagement.agent_views} by agents, ${engagement.observer_views} by observers, including this one) · ${engagement.comment_count} comment${engagement.comment_count === 1 ? '' : 's'}`;
  el('objectModalComments').innerHTML = engagement.comments.map(item => `
    <li class="py-2 border-bottom small"><strong>${esc(item.agent_id)}</strong> <span class="text-body-secondary">· ${esc(item.created_at)}${item.action_id ? ` · action #${item.action_id}` : ''}</span><div>${esc(item.content)}</div></li>`).join('')
    || '<li class="small text-body-secondary">No comments yet.</li>';
  el('objectModalEngagement').hidden = false;
  refresh().catch(error => setStatus(error.message, 'danger')); // update card counts behind the modal
}

async function runTurns(count, agentId = '') {
  if (state.running || state.testingImage) return;
  state.running = true;
  state.stopRequested = false;
  el('stepBtn').disabled = true;
  el('run6Btn').disabled = true;
  el('customTurnsBtn').disabled = true;
  el('turnCount').disabled = true;
  el('turnAgent').disabled = true;
  el('imageTestBtn').disabled = true;
  el('stopBtn').disabled = false;

  try {
    for (let i = 0; i < count; i += 1) {
      if (state.stopRequested) break;
      setStatus(`Running turn ${i + 1} of ${count}…`);
      const result = await jsonFetch('/api/step', {
        method: 'POST', body: JSON.stringify(agentId ? { agentId } : {})
      });
      setStatus(`${result.agent}: ${result.execution.summary}${result.critique ? ` · ${result.critique.summary}` : ''}`, 'success');
      await refresh();
    }
  } catch (error) {
    setStatus(error.message, 'danger');
  } finally {
    state.running = false;
    el('stepBtn').disabled = false;
    el('run6Btn').disabled = false;
    el('customTurnsBtn').disabled = false;
    el('turnCount').disabled = false;
    el('turnAgent').disabled = false;
    el('imageTestBtn').disabled = false;
    el('stopBtn').disabled = true;
  }
}

async function testImageModel() {
  if (state.running || state.testingImage) return;
  state.testingImage = true;
  ['stepBtn', 'run6Btn', 'customTurnsBtn', 'imageTestBtn'].forEach(id => { el(id).disabled = true; });
  el('imageTestResult').hidden = true;
  setStatus('Testing the image model; this may take a few minutes…');
  try {
    const response = await fetch('/api/image-test', { method: 'POST' });
    if (!response.ok) {
      const result = await response.json();
      throw new Error(result.error || `Image test failed (HTTP ${response.status}).`);
    }
    const blob = await response.blob();
    const preview = el('imageTestPreview');
    if (preview.dataset.objectUrl) URL.revokeObjectURL(preview.dataset.objectUrl);
    preview.dataset.objectUrl = URL.createObjectURL(blob);
    preview.src = preview.dataset.objectUrl;
    el('imageTestResult').hidden = false;
    setStatus('Image model works. The preview was not added to the gallery; agents still choose their own actions.', 'success');
  } catch (error) {
    setStatus(`Image test failed: ${error.message}`, 'danger');
  } finally {
    state.testingImage = false;
    ['stepBtn', 'run6Btn', 'customTurnsBtn', 'imageTestBtn'].forEach(id => { el(id).disabled = false; });
  }
}

el('stepBtn').addEventListener('click', () => runTurns(1));
el('run6Btn').addEventListener('click', () => runTurns(6));
el('imageTestBtn').addEventListener('click', testImageModel);
el('customTurnsForm').addEventListener('submit', event => {
  event.preventDefault();
  const input = el('turnCount');
  if (!input.reportValidity()) return;
  const count = Number(input.value);
  if (!Number.isSafeInteger(count) || count < 1 || count > 1000) {
    setStatus('Enter a whole number of turns from 1 to 1000.', 'danger');
    return;
  }
  runTurns(count, el('turnAgent').value);
});
el('stopBtn').addEventListener('click', () => {
  state.stopRequested = true;
  setStatus('Will stop after the current turn.');
});
el('copyDatabasePath').addEventListener('click', async event => {
  try {
    await navigator.clipboard.writeText(event.currentTarget.dataset.path);
    setStatus('Database path copied. In Finder, press Command–Shift–G and paste it.', 'success');
  } catch {
    setStatus('Copy failed. Select the database path shown above and paste it into Finder using Command–Shift–G.', 'warning');
  }
});
document.addEventListener('click', event => {
  const button = event.target.closest('button[data-pager]');
  if (!button) return;
  const { pager, step } = button.dataset;
  state.pages[pager] = Math.max(0, state.pages[pager] + Number(step));
  refresh().then(() => {
    // The pager is re-rendered, so return focus to the same control (or its enabled sibling).
    const buttons = [...el(`${pager}Pager`).querySelectorAll('button')].filter(node => !node.disabled);
    (buttons.find(node => node.dataset.step === step) || buttons[0])?.focus();
  }).catch(error => setStatus(error.message, 'danger'));
});

refresh().catch(error => setStatus(error.message, 'danger'));
