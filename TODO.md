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

## Open

- [ ] Check Cloudflare dashboard → Networking → Tunnels: the only connector
  should be the Pi on 2026.10.5+. Remove (or upgrade) any leftover connector
  from the old Windows PC (`start.bat`/`start.sh`).
- [ ] Update Node.js on the Pi so its bundled CA store drops the compromised
  eMudhra intermediates (affects outbound HTTPS from nodemailer and web-push).
