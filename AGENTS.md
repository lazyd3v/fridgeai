# Runtime and deployment

- The Raspberry Pi is the application runtime. Run the webserver, React asset serving, agent loop, SQLite, camera capture, and GPIO monitoring on the Pi.
- The Mac is for source editing, Git, isolated tests/type checks, and browser access over SSH. Do not start `npm run dev`, `dev:web`, `dev:server`, or `npm start` on the Mac unless the user explicitly requests a temporary local runtime.
- Primary URL: `http://fridgeai.local:3000`, served directly by the Pi on the home network. An optional Mac port 3002 SSH tunnel forwards to Pi port 3000; it is not a Mac-hosted app.

## Target

- SSH: `roman@fridgeai.local`
- Source: `/home/roman/fridge-ai`
- Data: `/home/roman/fridge-data`
- Secrets/configuration: `/home/roman/fridge-ai/.env` (mode 0600)
- Node: `/home/roman/.local/opt/node/bin/node`
- Service: `systemctl --user ... fridge-ai`
- Pi listener: `0.0.0.0:3000` (IPv4; LAN access explicitly requested by the user), serving the built React frontend and all API routes including `/api/agent/run`.
- Model: `gpt-6-luna`; model inference uses OpenAI, but the SDK loop and tools execute on the Pi.

## Deploy from the Mac

The ignored `.pi.env` supplies `PI_HOST=roman@fridgeai.local` and `PI_DIR=/home/roman/fridge-ai`.

For source changes:

```sh
npm run pi:sync
npm run pi:restart
```

`pi:restart` builds the frontend and type-checks on the Pi, then restarts the user service. If dependencies/lockfile changed, run `npm run pi:setup` after syncing and before restarting; this runs `npm ci` and builds on the Pi.

Sync excludes `.git`, `.env`, `.pi.env`, `node_modules`, `dist`, and `data`. Never overwrite or print the Pi's `.env`, copy secrets back to the Mac, or sync local databases/captures. Source deletions are not propagated by rsync; remove only the specific obsolete source files on the Pi when necessary.

## Access and verification

Open `http://fridgeai.local:3000` directly on the home network. No tunnel is required. Optionally start an SSH tunnel:

```sh
npm run pi:tunnel
```

The optional tunnel provides `http://127.0.0.1:3002`. Verify deployment with:

```sh
ssh roman@fridgeai.local 'systemctl --user is-active fridge-ai'
ssh roman@fridgeai.local 'curl -fsS http://127.0.0.1:3000/api/status'
```

Allow time for the service to start after restarting. `npm run pi:logs` streams service logs. Test the agent at `http://fridgeai.local:3000/api/agent/run`; use read-only prompts unless writes are part of the requested change. Never display API keys in logs, shell arguments, or chat.

The user service is not enabled at boot. After a reboot, start it with `ssh roman@fridgeai.local 'systemctl --user start fridge-ai'`, then open the LAN URL. The app has no authentication; do not configure router port forwarding/public exposure or change boot behavior without user authorization.

For a foreground watch session, stop the Pi service first, then run `npm run pi:run` from the Mac (it executes on the Pi). Restore the service afterward. Do not run two backends against the same Pi port/camera.

See `GPIO.md` for wiring and sensor controls. Preserve existing sensor configuration when deploying unrelated changes.
