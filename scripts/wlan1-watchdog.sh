#!/bin/bash
# wlan1 primary-uplink watchdog — recovers the BrosTrend (rtl8852bu) dongle.
# Runs every 5 min via systemd timer. wlan1 is the PRIMARY uplink (metric 100);
# wlan0 is the FALLBACK (metric 600) and must never be touched by this script.
#
# On 2026-07-24 the dongle's firmware wedged after a USB re-enumeration storm:
# the netdev stayed administratively DOWN even though `ip link set wlan1 up`
# returned success and NetworkManager could not recover it via `nmcli con up`
# ("Wi-Fi network could not be found"). The only fix was reloading the kernel
# module (`rmmod 8852bu; modprobe 8852bu`). This script automates that recovery
# path so a repeat outage doesn't sit unnoticed for 5 days again.
#
# SAFETY: this script only ever touches wlan1 / the 8852bu module / the
# brostrend-uplink NetworkManager profile. It must never touch wlan0 (the
# fallback uplink, which carries traffic while wlan1 is down) or eth0 (the
# isolated camera network).

IFACE=wlan1
PROFILE=brostrend-uplink
MODULE=8852bu
LOG_TAG=wlan1-watchdog
COOLDOWN_SECONDS=1800
COOLDOWN_MARKER=/run/wlan1-watchdog-last-reload
# Bound nmcli so a hung activation can't outlive the 5-minute timer interval.
NMCLI_WAIT_SECONDS=30
# Give the driver time to re-probe the USB device and register the netdev.
MODULE_SETTLE_SECONDS=10
UNLOAD_SETTLE_SECONDS=3
LINK_SETTLE_SECONDS=3

log() {
    logger -t "$LOG_TAG" "$1"
}

# Run a command, forward its output to syslog, and return ITS exit code.
# Note the deliberate avoidance of `cmd | logger` here: a pipeline's status is
# that of its LAST element, so piping straight into logger would report the
# status of logger (effectively always 0) and silently mask every failure.
run_step() {
    local description=$1
    shift
    local output
    local status
    output=$("$@" 2>&1)
    status=$?
    if [ -n "$output" ]; then
        printf '%s\n' "$output" | logger -t "$LOG_TAG"
    fi
    if [ "$status" -ne 0 ]; then
        log "${description} failed (exit ${status})"
    fi
    return "$status"
}

state=$(nmcli -t -f DEVICE,STATE dev status | grep "^${IFACE}:" | cut -d: -f2)

if [ "$state" = "connected" ]; then
    log "${IFACE} ok"
    exit 0
fi

log "${IFACE} is ${state:-MISSING} — attempting soft recovery"

if run_step "soft recovery (nmcli con up ${PROFILE})" \
        nmcli -w "$NMCLI_WAIT_SECONDS" con up "$PROFILE"; then
    log "${IFACE} soft recovery succeeded"
    exit 0
fi

now=$(date +%s)
if [ -f "$COOLDOWN_MARKER" ]; then
    last_reload=$(stat -c %Y "$COOLDOWN_MARKER" 2>/dev/null || echo 0)
    elapsed=$((now - last_reload))
    # A backward clock jump (this box has clock-reset history) would make elapsed
    # negative and wrongly suppress the reload until wall-clock catches up; treat
    # a future-dated marker as an expired cooldown.
    if [ "$elapsed" -ge 0 ] && [ "$elapsed" -lt "$COOLDOWN_SECONDS" ]; then
        log "module reload skipped — last reload ${elapsed}s ago, cooldown ${COOLDOWN_SECONDS}s"
        exit 0
    fi
fi

# Touch the marker before attempting the reload so a crash mid-reload still
# counts against the cooldown (avoids a reload thrash loop on a dead dongle).
touch "$COOLDOWN_MARKER"

log "reloading kernel module ${MODULE} (wedged-firmware recovery)"

# A failed unload is not fatal on its own: the reload below may still re-probe
# the device successfully, so log it and continue rather than aborting here.
run_step "modprobe -r ${MODULE}" modprobe -r "$MODULE"
sleep "$UNLOAD_SETTLE_SECONDS"

if ! run_step "modprobe ${MODULE}" modprobe "$MODULE"; then
    log "hard recovery aborted — ${MODULE} would not load"
    exit 1
fi
sleep "$MODULE_SETTLE_SECONDS"

run_step "ip link set ${IFACE} up" ip link set "$IFACE" up
sleep "$LINK_SETTLE_SECONDS"

if run_step "hard recovery (nmcli con up ${PROFILE})" \
        nmcli -w "$NMCLI_WAIT_SECONDS" con up "$PROFILE"; then
    log "${IFACE} hard recovery succeeded — module reload fixed it"
    exit 0
fi

log "${IFACE} hard recovery failed — dongle may need physical attention"
exit 1
