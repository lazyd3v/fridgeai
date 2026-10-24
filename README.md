# Fridge

A small home fridge tracker. Node.js + Express API, React + Vite interface, TypeScript throughout, and SQLite for persistent inventory. No containers or external services required.

For the magnetic door switch, wiring, calibration, and camera control, see [GPIO.md](GPIO.md).

## Run on your Mac

Use Node.js 22.13 or newer (Node 22 is pinned in `.nvmrc`).

```sh
npm install
cp .env.example .env
npm run dev
```

Open http://localhost:5173. React updates immediately; the API restarts when backend files change. The API listens on port 3001. If changing that port, also update the Vite proxy in `vite.config.ts`.

Take a snapshot to load the illustrated demo. Add and remove inventory manually. Data survives restarts in `data/fridge.sqlite`; captured images live in `data/captures/`. Neither is committed. SQLite may print an experimental API warning on Node 22.

## Camera modes

Set `CAMERA_MODE` in `.env`, then restart the server:

- `demo`: copies the included illustration. No hardware required.
- `replay`: copies the JPEG or PNG at `REPLAY_IMAGE=/absolute/path/photo.jpg`. Reuse the same photo to reproduce a scene. Video replay is not implemented yet.
- `usb`: uses one shared FFmpeg process and Linux V4L2 to stream MJPEG to the browser. Snapshots use the latest frame from that process, so they do not compete for the webcam. Set `CAMERA_SIZE`, `CAMERA_FPS`, and optionally `CAMERA_INPUT_FORMAT` to formats supported by your camera. The process stops five seconds after the last viewer disconnects. No audio or continuous video recording.

Snapshots do not change inventory. Automatic food recognition is not implemented. Captures are retained until you delete them; there is no automatic retention policy yet.

## Raspberry Pi workflow

Use Raspberry Pi OS (64-bit recommended), Node.js 22.13+, npm, rsync, and SSH key access. Configure an SSH alias such as `fridge-pi`, or use `username@hostname`.

```sh
cp .pi.env.example .pi.env
# Edit PI_HOST and PI_DIR for your Pi.
npm run pi:sync
npm run pi:setup
```

On the Pi, create `.env` in the app directory using `.env.example`. Set:

```dotenv
HOST=0.0.0.0
PORT=3001
DATA_DIR=/home/YOUR_USER/fridge-data
CAMERA_MODE=usb
CAMERA_DEVICE=/dev/video0
```

Install FFmpeg on the Pi with `sudo apt install ffmpeg`; the app user needs access to the camera device (typically membership in the `video` group, followed by a new login). Start with `CAMERA_MODE=demo` to verify connectivity before connecting a webcam.

Back on your Mac:

```sh
npm run pi:run
```

Open `http://fridge-pi.local:3001` using your Pi's actual hostname or IP. Logs stream into your terminal. Ctrl-C stops the development run. The server serves the built React UI and API together.

For each change, run `npm run pi:sync`. Backend changes restart the watching process. For frontend changes, stop and rerun `npm run pi:run` to rebuild; refresh your browser afterward. If dependencies change, stop the app, sync, and rerun `npm run pi:setup` first. Use local `npm run dev` for instant frontend feedback.

Sync is one-way from Mac to Pi and excludes `.env`, `.pi.env`, dependencies, build output, Git, and `data/`. It never uses `--delete`; after renaming or removing a source file, remove the old copy on the Pi explicitly. Keep Pi data outside the code directory as shown above. Do not edit the Pi's source copy directly.

The app has no authentication: bind to localhost during local development, and use LAN access only on a trusted home network. Do not forward its port from your router.

## Run unattended later

`npm run build && npm start` serves the app on port 3001. A systemd template is provided in `deploy/fridge-ai.service.example`. Replace the username, paths, and Node/npm location before copying it to `/etc/systemd/system/fridge-ai.service`, then run:

```sh
sudo systemctl daemon-reload
sudo systemctl enable --now fridge-ai
```

`journalctl -u fridge-ai -f` follows that system service's logs. `npm run pi:logs` follows the user service used by the POC below. Stop the service before using `pi:run` on the same port. After syncing updates to an unattended installation, rebuild and restart the service.

## Development checks

```sh
npm run check
npm test
npm run build
```

`server/camera.ts` handles capture sources, `server/store.ts` owns SQLite persistence, `server/app.ts` exposes the API, and `src/` contains the React UI. The next milestone is applying recognition to saved snapshots before connecting recognition to inventory updates.

## Current Pi POC

Target: `roman@fridgeai.local`, source in `/home/roman/fridge-ai`, data in `/home/roman/fridge-data`. Node 22 is installed at `/home/roman/.local/opt/node`. The app is bound to **127.0.0.1:3001 on the Pi**; access it through an SSH tunnel:

```sh
npm run pi:tunnel
```

Open http://localhost:3002 on the Mac. The webcam is configured for 1280×720 at 20 FPS using MJPEG passthrough. The app uses the AnkerWork C310's stable `/dev/v4l/by-id/` camera path. USB mode automatically opens the live stream, with pause/reconnect buttons and snapshots. One capture process is shared across viewers; slow viewers skip frames.

The POC uses `deploy/fridge-ai.user.service` installed under `~/.config/systemd/user/fridge-ai.service`. It is started for this session, **not enabled at boot**. Commands:

```sh
ssh roman@fridgeai.local 'systemctl --user start fridge-ai'
npm run pi:sync
npm run pi:restart
npm run pi:logs
ssh roman@fridgeai.local 'systemctl --user stop fridge-ai'
```

Stop this service before using `pi:run`. To work on the local React UI against the real Pi, run `API_TARGET=http://127.0.0.1:3002 npm run dev:web` while the tunnel is open. This gives frontend hot reload with the live Pi API.

FFmpeg must be installed on the Pi (`sudo apt-get install ffmpeg v4l-utils`). Check camera formats with `v4l2-ctl --device=/dev/video0 --list-formats-ext` before increasing resolution or frame rate.

Hardware verification: two concurrent streams received JPEG frames, a snapshot succeeded while streaming, the camera process stopped after viewers disconnected, and reconnecting started it again.
