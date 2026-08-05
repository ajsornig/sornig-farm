# chicken-stream

Live streaming website for backyard chickens ("Sornig Farm"). Node.js/Express backend with WebSocket chat, HLS video streaming, user auth with an approval system, admin panel, visitor map, and motion-capture timelapses.

## Architecture

- **Cameras**: 3x Reolink on an isolated camera network (10.0.0.x, no internet by design) behind the Pi — 2x RLC-510WA ("ChickenRun1" 10.0.0.10, "ChickenCoop1" 10.0.0.11; RTSP + proprietary port only, HTTP API disabled) and 1x E1 ("ChickCam" 10.0.0.12; HTTP API on :80, ONVIF PTZ on :8000)
- **Video path**: cam RTSP sub-streams → Raspberry Pi 5 8GB (ffmpeg `-c:v copy` pass-through, systemd `camera-hls{,-2,-3}`) → HLS in `public/hls{,2,3}/` → this server → Cloudflare Tunnel → sornigfarm.com
- **Server**: `server/index.js` (entry), Express 4 + `ws` for chat, nodemailer for email/SMS alerts; the Pi also runs chrony as the cams' NTP server (10.0.0.1)
- **Monitoring**: `scripts/wifi-monitor.sh` logs 1 line/min; `server/infra-alerts.js` polls it and texts on sustained criticals (respects admin-disabled cams, 3 alerts max per incident)

## Commands

```
npm start      # run server (node server/index.js)
npm run dev    # run with --watch auto-reload
npm test       # node --test test/*.test.js  (scoped: scripts/test-preset.js sends a LIVE PTZ command — never let test discovery reach it)
```

## Files & conventions

- `config.json` is the live config (secrets, ports) — never commit it; `config.json.example` is the committed template. Repo is PUBLIC.
- `data/` and `data.json` hold runtime state (users are a dict keyed by lowercase username); `logs/` is runtime logs; neither is source code
- `.hidden-cams/` holds admin panel camera-visibility flag files (gitignored)
- `backup.sh` handles backups (off-box to USB at /mnt/backup)
- Static assets are Cloudflare-cached: bump `?v=` in BOTH `public/index.html` and `public/admin.html` when changing `style.css`/`app.js`
- Operational details, credentials, and hardware history live in `SornigReadMe.txt` (untracked)

## Agents & delegation

- For non-trivial features: plan at the session level, delegate mechanical
  implementation (clear spec already written, renames, repetitive edits) to
  cheaper-model agents (Sonnet), then review the result at the session level.
- For significant changes, spawn a Fable agent as an independent code-review
  gate before testing; fix findings until it approves.
- Fable's usage pool is separate from other models and can run out. If a Fable
  agent is unavailable, use the strongest available model (e.g. Opus) for the
  review/critic role instead — never skip the gate, and mention the substitution.
- Don't delegate trivial tasks — spawning an agent costs more than doing it inline.
- After 2+ context compactions, suggest a fresh session.
