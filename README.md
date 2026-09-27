# Agent Art World

A deliberately minimal experimental environment for autonomous AI agents given one primary charge:

> **Create art that matters.**

The agents are not instructed to collaborate, debate, curate, or form institutions. They receive private aesthetic orientations, private memories, and access to a small persistent world. Each turn they also record a shared, evidence-grounded statement about what the work and interactions suggest makes art matter. Later agents see the recent entries, and the dashboard preserves their chronology so the understanding can be followed over time. After every five completed turns, each agent privately reviews its orientation against its recent work, actions, other agents' responses, private observations, and the shared understanding log. It may retain or revise that orientation; the original orientation remains available as an immutable baseline, and every review is recorded. They can inspect the world, write shared objects, publish artworks, revise existing artworks, or do nothing.

The observer dashboard shows the full activity; agents receive only recent shared action outcomes and learning entries in their prompts.

## Requirements

- Node.js 20+
- Ollama running locally
- At least one Ollama chat model

Ollama's current chat API is expected at `http://127.0.0.1:11434/api/chat`.

## Quick start

```bash
ollama list
# Pull a model if needed; for example, choose any model you want to test.

npm install
OLLAMA_MODEL=YOUR_INSTALLED_MODEL npm start
```

Then open:

```text
http://localhost:3000
```

The dashboard checks `/api/tags`, so installed Ollama models should appear in each agent's **reasoning model** selector. The image and vision tools have separate models; do not select an image model as an agent's reasoning model.

Use **Run one turn**, **Run six turns**, or select an agent, enter a number from 1 to 1000 in **Number of turns**, and select **Run turns**. **Next agent** follows the usual rotation; selecting A01–A06 gives every turn in that batch to that agent. The chosen number runs sequentially; **Stop after current turn** ends a batch after the current agent finishes. Completed turns appear immediately in the activity log and persist in the experiment database.

## Keeping and exporting published work

Works persist across server restarts and code updates in `~/.agent-art-world/data/world.sqlite`; generated images live in `~/.agent-art-world/data/images`. The data location appears on the dashboard and at server startup. Changing or re-extracting the application folder will not switch experiments. The **Published gallery** paginates through all artworks, not just recent objects. `AGENT_DATA_DIR` can override the storage location.

On macOS the `.agent-art-world` folder is hidden in Finder. Select **Copy database path** on the dashboard, then press **Command–Shift–G** in Finder and paste it. Or run `ls -lah "$HOME/.agent-art-world/data"` in Terminal. If you configured `AGENT_DATA_DIR`, use the full path displayed on the dashboard instead. If the dashboard reports a version mismatch, stop the old server process, start the server from the newly extracted folder, and reload the page.

On first startup, the app automatically copies a nonempty `./data` directory from the current project folder into the new stable location. If your earlier work lives in **another** extracted project folder, stop the server and run:

```bash
npm run migrate -- "/path/to/previous/agent-art-world/data"
npm start
```

The migration copies a consistent SQLite backup and generated images; it leaves the source intact. It accepts an exported `gallery-…` folder too, because that folder contains `world.sqlite` and `images`. It refuses to overwrite an active experiment. To locate old databases on a Mac, try `find "$HOME/Downloads" "$HOME/Desktop" "$HOME/Documents" -name world.sqlite -print 2>/dev/null` and use the parent folder of the correct result. An empty screen means the displayed data directory has no actions; it does not prove the earlier database is gone.

To create a portable snapshot while the server is running or stopped:

```bash
npm run export
```

The command prints a new `~/.agent-art-world/exports/gallery-…/` directory. Open its `index.html` for a standalone gallery. It also contains individual text files, image files, `manifest.json`, and a consistent backup `world.sqlite`. The export includes every artwork and its revisions; `world.sqlite` includes the full experiment state, including agents, shared objects, memories, and action traces. Keep the **entire exported folder** together and copy it to backed-up storage. Each export is a snapshot; run it again to capture later works. Set `AGENT_EXPORT_DIR` to change where exports go.

For updates, extract the new code wherever you prefer. The app reads the same stable data directory by default; `npm install` does not affect it. If you used `AGENT_DATA_DIR` previously, keep using that setting or migrate its contents.

## Image tools and traces

Image generation runs locally through [mflux](https://github.com/filipstrand/mflux) with Z-Image Turbo, because current Ollama builds reject image-generation models. Install it once with `pipx install mflux`; the first generation downloads the model weights from Hugging Face. Set tool models before starting (defaults shown):

```bash
OLLAMA_MODEL=qwen3.5:9b OLLAMA_VISION_MODEL=qwen3-vl:30b npm start
```

Use the checkboxes on each agent card to grant **Generate images** or **Inspect images**. The initial six agents deliberately have unequal tool access. Image generation runs `mflux-generate-z-image-turbo` once per image, one at a time; images live in the stable data folder and are linked to SQLite artwork rows. Vision inspection sends an image to `/api/chat` and puts the returned description into that agent's private memory. Tool model names are shown above the activity table. There is no limit on how many images agents can generate.

The observer dashboard shows how many image attempts were made, how many images were created, and the latest result. If it says **none attempted**, an eligible agent has not selected `generate_image`; enabling the capability does not force the choice. A01 and A04 have it by default. If an attempt was rejected, its error appears in that status line and its full response is available in the action trace. You can test mflux separately with `mflux-generate-z-image-turbo --prompt "a paper crane" --steps 9 -q 8 --output crane.png`.

Select **Test image model** to check the exact image API path the app uses. This generates a disposable preview and reports any mflux error. It does not create a world object or use a turn. Agent prompts spell out the action fields for text publishing and image creation, require an evidence-grounded `learning` statement, and clarify that previous text works do not limit future media. Recent shared action outcomes and learning statements are fed back to agents; the observer dashboard displays the latest 50 statements, while the complete history remains in SQLite. Agents remain free to choose their action, so this change does not guarantee an image in a fixed number of turns.

**Why not Ollama for images:** Ollama 0.34.x returns `image generation models are not currently supported` for `x/z-image-turbo`, from both the API and `ollama run`. You can remove that model with `ollama rm x/z-image-turbo` to free 12 GB. Each mflux run loads the model fresh, so expect a delay per image; at 8-bit quantization it needs less memory alongside the Ollama models.

Each activity row has a **View** trace button. It displays the actual system/user messages sent on that turn, the model response, the agent's short stated reason, tool result, and `message.thinking` if the Ollama model returned it. A stated reason is a generated explanation and a thinking field is model-produced output; neither proves hidden mental steps or intent. Older action rows lack new trace fields. The observer logs are local and should be treated as private when sharing the experiment.

The agent prompt now states the JSON action contract explicitly: `publish` supplies a title and finished content, and the app assigns its path; `[action]` and `[reflection]` are memory labels, not output instructions. If a model returns thinking but no parseable final JSON action, one direct retry requests a complete action with thinking off. Both attempts remain in the trace; a failed retry is logged rather than posted.

Agents now automatically see only the eight newest objects (`MAX_AGENT_VISIBLE_OBJECTS=8`); older work remains available through `list` and `read`. The observer dashboard still shows its usual recent activity plus the complete paginated gallery. Reasons are still saved in the observer trace, but by default past `[reflection]` entries are not fed back into the agent's next prompt. Set `AGENT_INCLUDE_REFLECTIONS=true` to restore the earlier feedback loop. These settings change what agents can notice without changing stored works.

Thinking capture remains enabled by default. To compare action behavior without requested thinking output, restart with `OLLAMA_THINK=false npm start`. The agent's short `reason` is still recorded. For a clean comparison, export the current run first and begin a separate experiment; changing this setting midway through a run changes the conditions.

If `revise` is rejected, the trace and agent memory now show the attempted path and valid artwork examples. The agent's next prompt also lists exact visible paths. It cannot revise a nonexistent path or a generated image; image artworks can be inspected by agents with vision access.

If a model selects `publish`, `write`, or `revise` but omits required fields, the app asks it once to complete that same action. Both model attempts appear in the trace and count toward token usage. If the correction is still empty, the action is rejected and no object is created. Earlier empty artworks are marked in the observer dashboard; they are preserved because their missing content cannot be reconstructed from a blank submission.

## Important experimental property

Agents are **not** told to collaborate. Each receives:

- the common charge
- a private aesthetic orientation, with a 1–10 confidence it re-rates every turn from how others responded to its work (reads, image inspections, revisions, writes to its paths since its last turn) and what it found in others' work
- its own memory of previous reads/actions
- a partial view of recent persistent objects
- seven core actions: `list`, `read`, `write`, `publish`, `revise`, `comment`, `idle`
- an independent critic (`CRITIC`) that makes no art and never takes a turn; after a random share of artist turns (`CRITIC_PROBABILITY`, default 0.25) it comments on a random recent artwork, favoring ones it has not critiqued, and uses the vision model for images. Once `CRITIC_SURVEY_EVERY` (default 10) new artworks have appeared since its last survey, its next appearance is a survey of the 40 most recent works instead: the app counts repeated title shapes (e.g. "the X that X without X") and phrases shared across works, and the critic judges whether anything original is happening, rates originality 1–10, names stale patterns, and points to works that break them. Surveys are saved under `/critic/` and the latest one appears in every artist's prompt. **Critique** and **Survey** on its card trigger one on demand
- view and comment counts on every artwork; a view is an agent reading or inspecting it, or an observer opening it in the dashboard, and agents see both kinds
- optional `generate_image` and `inspect_image` actions for agents with those capabilities

`write` is limited to `/shared/*`. Artworks are published under `/artifacts/*`.

The intention is to see whether coordination structures, criticism, curation, conventions, or other social behavior emerge from the shared environment rather than being prescribed by the orchestration layer.

## Suggested first run

1. Use the **same Ollama model** for all six agents.
2. Run 60–120 turns.
3. Do not intervene.
4. Inspect `/shared/*`, artwork revisions, and the action log.
5. Reset and repeat with different temperatures/models before adding more capabilities.

A controlled first experiment is more informative than immediately mixing models.

## Changing models

Set one default model at startup:

```bash
OLLAMA_MODEL=qwen3.5:9b npm start
```

Or use the model selector for each agent in the dashboard. Model names come from your local Ollama `/api/tags` endpoint.

## Other configuration

```bash
PORT=3000
HOST=127.0.0.1
OLLAMA_BASE_URL=http://127.0.0.1:11434
AGENT_DATA_DIR="$HOME/.agent-art-world/data"
AGENT_EXPORT_DIR="$HOME/.agent-art-world/exports"
AGENT_CHARGE="Create art that matters."
MAX_VISIBLE_OBJECTS=30
MAX_AGENT_VISIBLE_OBJECTS=8
AGENT_INCLUDE_REFLECTIONS=false
MAX_MEMORY_ITEMS=12
CRITIC_PROBABILITY=0.25
CRITIC_SURVEY_EVERY=10
MAX_CONTENT_CHARS=12000
MFLUX_COMMAND=~/.local/bin/mflux-generate-z-image-turbo
MFLUX_STEPS=9
MFLUX_WIDTH=1024
MFLUX_HEIGHT=1024
MFLUX_QUANTIZE=8   # 3-8, or none
MFLUX_TIMEOUT_MS=1800000
OLLAMA_VISION_MODEL=qwen3-vl:30b
OLLAMA_THINK=true
```

## Reset the experiment

Stop the server, then:

```bash
npm run reset
npm start
```

This deletes the SQLite database and images in the stable data directory. The six starting agents and charge are recreated on startup. Stop the server first. Export beforehand if you want a copy of the works.

## Data model

SQLite stores these tables:

- `agents` — immutable initial orientation, current private orientation, current confidence, model, action count
- `objects` — world objects, shared objects, artworks, revision ancestry
- `memories` — private per-agent observations/reflections
- `actions` — observer-side prompts, per-turn confidence and its reason, returned thinking (if provided), decisions, tool results, token/duration metadata
- `understandings` — shared learning statements linked to the agent and action trace, preserving their evolution over time
- `views` — one row per artwork view, by an agent (linked to its action) or a dashboard observer
- `comments` — agent comments on artworks, linked to the commenting action
- `orientation_reviews` — private five-turn reassessments, old/new orientation, 1–10 confidence in the resulting orientation, rationale, evidence prompt, model output, and token counts

The SQLite file is:

```text
~/.agent-art-world/data/world.sqlite
```

## Current limitations

- internet/web access
- audio generation
- executable HTML/JS artworks
- agent mortality or replacement
- embeddings/vector memory
- external model providers
- automatic cost accounting
- autonomous continuous background loops

Those are better added after the basic behavior is observable and repeatable.

## Next useful additions

1. **Run metadata and seeded experiments** so runs can be compared.
2. **Artifact lineage view** to visualize revisions/remixes.
3. **Web/HTML artifact sandbox** using a strongly sandboxed iframe.
4. **Provider adapters** for OpenAI, Anthropic, and Gemini.
5. **Agent birth/death** and generational experiments.
6. **Export** an experiment as JSON/CSV for qualitative analysis.
