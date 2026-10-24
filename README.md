# Fridge

A small home fridge tracker. Node.js + Express API, React + Vite interface, TypeScript throughout, and SQLite for persistent inventory. No containers or external services required.

For the magnetic door switch, wiring, calibration, and camera control, see [GPIO.md](GPIO.md).

## Minimal AI agent

The OpenAI Agents SDK runs a tool loop in the Node backend using `gpt-6-luna` through the Responses API. Set `OPENAI_API_KEY` in the server's ignored `.env` file and restart the server. On the Pi, edit `/home/roman/fridge-ai/.env`; local `.env` files are deliberately not synced.

```sh
curl http://fridgeai.local:3000/api/agent/run \
  -H 'Content-Type: application/json' \
  -d '{"prompt":"What is in my fridge, and is the door open?"}'
```

The command connects directly to the Pi over the home network. The response contains `model`, `output`, and a `toolCalls` list. Try `Add two apples to my inventory, then list my inventory` to exercise a write tool. Refresh the existing inventory UI to see changes.

Tools: `get_inventory`, `get_fridge_status`, `add_inventory_item`, `scan_initial_inventory`, and `get_initial_scan`. The SDK handles model → tool → result → model until a final reply, at most eight turns, with a 60-second timeout. One run is allowed at a time. Each request starts fresh; there is no chat history, automatic trigger, or agent UI yet. Uploaded video scans run separately in background jobs; see below. SDK tracing is disabled. Prompts and tool results are sent to OpenAI when you invoke the endpoint. Successful tool writes persist even if a later model call fails; inspect inventory before retrying an interrupted write request.

## Fridge MCP server

For authenticated remote access from ChatGPT, see
[Cloudflare Tunnel and OAuth setup](CLOUDFLARE-MCP.md). The deployed public URL is
`https://fridge-mcp.example.com/mcp`; Cloudflare Access protects it, and the tunnel
forwards only the MCP path.

The Pi serves a stateless Streamable HTTP MCP endpoint at
`http://fridgeai.local:3000/mcp` alongside the existing application. Configure an
MCP client with that URL using the Streamable HTTP transport. The client must be
able to reach the Pi on the home network (or use the optional SSH tunnel at
`http://127.0.0.1:3002/mcp`).

Exactly one tool is exposed: `get_fridge_contents`, displayed as “What's currently
in my fridge”. It takes no arguments and returns `items`, `retrievedAt` (UTC), and
`source: "saved_inventory"` as both structured content and JSON text. Each item
includes its stored ID, name, quantity, notes, icon, and creation timestamp. An
empty inventory returns `items: []`. Every call reads SQLite afresh; this is the
saved inventory, not a live camera scan or a guarantee of physical contents.
The tool does not invoke a model or modify inventory.

The endpoint uses the same Pi process and database as the app, with no separate
service or port. It shares the app's trusted-home-network access model and has no
authentication. Deploy with `pi:sync`, `pi:setup` (new dependency), and
`pi:restart` as described below. GET/SSE subscriptions and DELETE sessions are
unsupported (HTTP 405); clients initialize and call tools using POST.

## Runtime

The webserver, React frontend serving, agent loop, database, webcam, and GPIO run on **the Raspberry Pi**. The Mac is used for editing, Git, isolated tests, and browser access. Do not start a local app server on the Mac.

Open http://fridgeai.local:3000 directly on your home network; no Mac server or SSH tunnel is needed. Deployment instructions and agent working rules are in [AGENTS.md](AGENTS.md).

## Camera modes

Set `CAMERA_MODE` in `.env`, then restart the server:

- `demo`: copies the included illustration. No hardware required.
- `replay`: copies the JPEG or PNG at `REPLAY_IMAGE=/absolute/path/photo.jpg`. Reuse the same photo to reproduce a scene. Video replay is not implemented yet.
- `usb`: uses one shared FFmpeg process and Linux V4L2 to stream MJPEG to the browser. Snapshots use the latest frame from that process, so they do not compete for the webcam. Set `CAMERA_SIZE`, `CAMERA_FPS`, and optionally `CAMERA_INPUT_FORMAT` to formats supported by your camera. The process stops five seconds after the last viewer disconnects. No audio or continuous video recording.

Snapshots do not change inventory. Automatic food recognition is not implemented. Captures are retained until you delete them; there is no automatic retention policy yet.

## Raspberry Pi workflow

The configured target is `roman@fridgeai.local`, with source at `/home/roman/fridge-ai`. Edit locally, then deploy:

```sh
npm run pi:sync
npm run pi:restart
```

If dependencies changed, run `npm run pi:setup` after syncing and before restarting. It installs from the lockfile on the Pi. `pi:restart` builds on the Pi and restarts the service.

The Pi's `.env`, SQLite database, captures, and dependencies are excluded from sync. Sync does not delete obsolete files; remove specific renamed/deleted source files on the Pi when required.

For a foreground backend watch session, stop the Pi service, then use `npm run pi:run`, which executes remotely. Restore the service afterward. Frontend changes require a Pi rebuild and browser refresh.

## Development checks

Isolated checks may run on the Mac; deployment also type-checks and builds on the Pi.

```sh
npm run check
npm test
npm run build
```

`server/camera.ts` handles capture sources, `server/store.ts` owns SQLite persistence, `server/app.ts` exposes the API, and `src/` contains the React UI. The next milestone is applying recognition to saved snapshots before connecting recognition to inventory updates.

## Current Pi POC

Target: `roman@fridgeai.local`, source in `/home/roman/fridge-ai`, data in `/home/roman/fridge-data`. Node 22 is installed at `/home/roman/.local/opt/node`. The app listens on **IPv4 port 3000 on the Pi** at http://fridgeai.local:3000. An optional SSH tunnel provides localhost:3002:

```sh
npm run pi:tunnel
```

Open http://fridgeai.local:3000 on a device on the same home network. The app has no authentication; keep it on the trusted home network, without router port forwarding. The webcam is configured for 1280×720 at 20 FPS using MJPEG passthrough. The app uses the AnkerWork C310's stable `/dev/v4l/by-id/` camera path. USB mode automatically opens the live stream, with pause/reconnect buttons and snapshots. One capture process is shared across viewers; slow viewers skip frames.

The POC uses `deploy/fridge-ai.user.service` installed under `~/.config/systemd/user/fridge-ai.service`. It is **enabled at boot**, with user lingering enabled for `roman`, so it starts after power-up without an SSH login. The service automatically restarts on failure. Verify with `systemctl --user is-enabled fridge-ai` and `loginctl show-user roman -p Linger` over SSH. Commands:

```sh
ssh roman@fridgeai.local 'systemctl --user start fridge-ai'
npm run pi:sync
npm run pi:restart
npm run pi:logs
ssh roman@fridgeai.local 'systemctl --user stop fridge-ai'
```

Stop this service before using `pi:run`; restore it after the foreground session. Run all application servers on the Pi.

FFmpeg must be installed on the Pi (`sudo apt-get install ffmpeg v4l-utils`). Check camera formats with `v4l2-ctl --device=/dev/video0 --list-formats-ext` before increasing resolution or frame rate.

Hardware verification: two concurrent streams received JPEG frames, a snapshot succeeded while streaming, the camera process stopped after viewers disconnected, and reconnecting started it again.

## Read-only initial video scan

Initial scans retain their original name/notes inventory response and do not receive saved inventory context. Door-session analysis is separate in `server/door-ai.ts`: it receives only product titles and returns product/action pairs. See `GPIO.md` for the door workflow.

The Pi accepts an uploaded video and calls OpenRouter `qwen/qwen3.8-flash` using private Hetzner object storage. Scanning never writes to SQLite or changes inventory. No changes to the inventory schema or UI are needed.

Configure `OPENROUTER_API_KEY`, `S3_ENDPOINT=https://fsn1.your-objectstorage.com`, `S3_BUCKET=fridgeai`, `S3_REGION=fsn1`, `S3_ACCESS_KEY_ID`, and `S3_SECRET_ACCESS_KEY` in the Pi's existing `.env` (mode 0600). Never commit credentials. FFmpeg and ffprobe must be available on the Pi.

Uploads use private objects under `media/` and signed GET URLs that expire after 24 hours. The bucket must be private; uploads are rejected if a public-read bucket policy is detected. Before upload, the service merges a one-day expiration rule for that prefix into the bucket lifecycle without changing unrelated rules. It also deletes objects older than 24 hours every minute while running, including on startup. Hetzner lifecycle deletion is asynchronous and provides a fallback when the Pi is offline; physical deletion is not guaranteed at the exact 24-hour mark. Versioned buckets also expire noncurrent versions after one day. Cleanup needs list/delete permissions; upload setup needs bucket policy read and lifecycle read/write permissions. Signed media URLs and credentials are never returned in scan results or logged.

Upload raw MP4/MOV bytes (not multipart and not JSON):

```sh
curl -f http://fridgeai.local:3000/api/videos \
  -H 'Content-Type: video/quicktime' \
  --data-binary '@/Users/romanfayzullin/Downloads/IMG_8916.MOV'
# Returns {"videoId":"..."}

curl -f http://fridgeai.local:3000/api/initial-scans \
  -H 'Content-Type: application/json' -d '{"videoId":"YOUR_VIDEO_ID"}'
# Returns HTTP 202 with scanId and status

curl -f http://fridgeai.local:3000/api/initial-scans/YOUR_SCAN_ID
# Returns processing, completed with result, or failed with error

curl -f http://fridgeai.local:3000/api/initial-scans/YOUR_SCAN_ID/result
# Returns only {"items":[{"name":"Milk","notes":"One carton."}]}
```

Agent tools `scan_initial_inventory({videoId})` and `get_initial_scan({scanId})` use this same service. Pass an uploaded videoId in the prompt to `/api/agent/run`; ask for the result in a later request. The agent must never automatically save scanned items. Scan observations returned to the agent are sent to OpenAI as tool results; the video is stored in Hetzner and accessed by OpenRouter’s selected model provider.

Uploads are limited to 512 MiB and videos to 2 seconds–5 minutes. The Pi remuxes the original video stream into an audio-free MP4 without re-encoding. OpenRouter routes the video URL to a video-capable provider; frame sampling is provider-controlled. Names/notes are observations, not guaranteed exhaustive inventory. Use an MP4-compatible video codec such as H.264 or HEVC. One scan and at most two waiting uploads are allowed. Repeating a videoId returns its existing job instead of charging for a duplicate scan.

Local videos are removed after processing or failure; unused uploads and finished results expire after about an hour. Jobs/results live in memory, not SQLite, and are lost on restart. Graceful shutdown removes local videos; after an unclean shutdown, orphan `scan-*` directories in DATA_DIR may need removal. Provider errors are sanitized so credentials and signed URLs are not logged. There are no automatic retries of billable inference calls.

### UI and private food artwork

The dashboard uses a responsive sidebar, camera view, inventory cards, session activity,
and a MISO assistant preview. Recipes, shopping, expiry tracking, and assistant chat are
visibly marked as upcoming. Activity lists changes made in the current browser session;
it is not a persistent audit log. Inventory remains stored on the Pi.

Purchased food artwork belongs in `public/private-food-icons/`, which is ignored by Git.
The app uses 147 curated 128px designs from the 400-icon collection.
`server/icon-catalog.json` is the allowlist, grouped by food type. It keeps fridge
ingredients, opened condiments, cold drinks, and common leftovers, and excludes pantry
staples, hot drinks, frozen desserts, niche dishes, and redundant preparation stages.
Potato remains because it is in the current inventory. The original collection stays
untouched outside the repository. Removed runtime icons are archived on the Pi.
Keep the license and AI disclosure with that private folder. New manual and agent additions
use OpenAI's Decisions API (`gpt-6-luna`) on the Pi to select an icon from the built
`dist/private-food-icons/` PNG filenames in the allowlist using the product title and optional notes.
The selected filename is stored in SQLite and reused by inventory and activity cards.
The existing server `OPENAI_API_KEY` is used; no new dependency or credential is needed.
A missing key, missing artwork, API failure/refusal, or no suitable match saves `none`
and shows the generic leaf. Each API request times out after eight seconds without blocking
the addition indefinitely. Catalogs above 254 icons are compared in groups, then the
group winners are compared in a final Decisions question (255 choices maximum, including none). Existing rows retain whole-word legacy matching (so
pineapple no longer matches apple); they are not automatically sent for reclassification.
The items API accepts optional notes up to 2000 characters, also supported by the agent tool.
See the [Decisions API guide](https://developers.openai.com/api/docs/guides/decisions).
A fresh checkout works without the purchased assets. To restore them privately, copy the
corresponding pack's `main/<design>/128.png` to
`public/private-food-icons/<design>.png` using lowercase names and underscores.
Only install designs listed in `server/icon-catalog.json`; update that allowlist to
intentionally expand the catalog. Extra files are excluded from model selection.
After changing the allowlist, archive excluded files from both source and built assets:

```sh
python3 scripts/prune-icons.py --archive /home/roman/fridge-data/excluded-food-icons
```

Run that command on the Pi after syncing; rsync does not propagate source deletions.
The script moves only excluded PNGs and preserves the license and disclosure.
Rebuild and restart after adding artwork to refresh the available icon catalog.

The regular Pi sync includes this ignored folder for private runtime use, and Vite copies
it into the ignored `dist/` build. Do not force-add either the private folder or generated
build assets to Git, or upload them as a standalone asset collection.
