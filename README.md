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

Tools: `get_inventory`, `get_fridge_status`, and `add_inventory_item`. The SDK handles model → tool → result → model until a final reply, at most eight turns, with a 60-second timeout. One run is allowed at a time. Each request starts fresh; there is no chat history, image analysis, automatic trigger, or agent UI yet. SDK tracing is disabled. Prompts and tool results are sent to OpenAI when you invoke the endpoint. Successful tool writes persist even if a later model call fails; inspect inventory before retrying an interrupted write request.

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

The POC uses `deploy/fridge-ai.user.service` installed under `~/.config/systemd/user/fridge-ai.service`. It is started for this session, **not enabled at boot**. Commands:

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
