# TODO

## Recurring

- [ ] **Keep cloudflared up to date on the Pi.** It was installed from a `.deb`
  (no apt repo) and the systemd unit runs with `--no-autoupdate`, so it never
  updates itself. Check `cloudflared --version` against the
  [latest release](https://github.com/cloudflare/cloudflared/releases), and
  upgrade promptly when Cloudflare emails an "Action Required" notice:
  ```
  cd /tmp
  wget https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-arm64.deb
  sudo dpkg -i cloudflared-linux-arm64.deb
  sudo systemctl restart cloudflared
  cloudflared --version
  journalctl -u cloudflared --since "5 min ago" --no-pager | grep -i "registered tunnel connection"
  rm cloudflared-linux-arm64.deb
  ```
  Expect ~4 "Registered tunnel connection" lines; the restart drops chat and
  video for a few seconds. Last done: 2026-10-28 (2026.5.0 → 2026.10.5, for the
  eMudhra weak-key certificate advisory).
  - Optional: switch to Cloudflare's apt repo (pkg.cloudflare.com) so plain
    `apt upgrade` covers it.
- [ ] **Watch-only tuning** (no action unless something drifts): coop motion-blur
  sigma, chick-cam autotrack return timers, chick-cam day/night threshold, and the
  bot-detect block log.

## Open

- [ ] Check Cloudflare dashboard → Networking → Tunnels: the only connector
  should be the Pi on 2026.10.5+. Remove (or upgrade) any leftover connector
  from the old Windows PC (`start.bat`/`start.sh`).
- [ ] Update Node.js on the Pi so its bundled CA store drops the compromised
  eMudhra intermediates (affects outbound HTTPS from nodemailer and web-push).
- [ ] Confirm the Cloudflare Tunnel has stayed stable since the 2026-08-02 IPv4
  pin (`edge-ip-version: "4"` + http2, which took it off the backup USB WiFi
  dongle). The per-sample `cfdrops` field in the wifi-monitor log should stay
  near 0.
- [ ] Add a critical alert for the **primary** WiFi uplink (wlan0) going dark.
  Right now only the backup uplink (wlan1) pages; if wlan0's signal drops there is
  no alert even though it carries all traffic. Add a `critical` `wlan0` key in
  `server/infra.js` (the default 3-sample sustain is fine — built-in radio, no
  Realtek flake).
- [ ] Harden the `cfdrops` field in `scripts/wifi-monitor.sh` so a journalctl/grep
  failure logs `cfdrops=?` instead of `0` — it currently can't tell "genuinely 0
  drops" from "the check itself failed." Do this before wiring any alert or
  dashboard card to the field.
- [ ] Re-generate the admin 2FA backup codes and record them in SornigReadMe.txt
  (the original enrollment set was never saved). Details in SornigReadMe.txt.
- [ ] PWA device tests: iPhone Safari shows the install-banner hint and a dismiss
  sticks; Android Chrome one-tap Install works; one longer PWA background-resume
  stretch (a short test already passed).
- [ ] Swap in the new 256 GB SD card (already ordered) — the current card is near
  capacity.
- [ ] Night-walk test in the run cam (lens was cleaned — a spider web, not the
  exposure floor, was the night-miss cause). Afterward check `skipped_exposure` /
  `skipped_cooldown` in the motion-capture stats log.
- [ ] Point the run + coop cameras' NTP at the Pi's local NTP server in the Reolink
  app (on the camera network, ~30s each). Low urgency — only matters after their
  next power loss.
- [ ] 24/7 security surveillance — long-term, likely a separate NAS + Frigate
  project.
