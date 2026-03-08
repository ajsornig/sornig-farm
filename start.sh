#!/bin/bash
# Chicken Stream Startup Script
# Usage: ./start.sh

echo "Starting Chicken Stream..."

# Start the web server in the background
cd "$(dirname "$0")"
node server/index.js &
WEB_PID=$!
echo "Web server started (PID: $WEB_PID)"

# Start the Cloudflare tunnel
echo "Starting Cloudflare tunnel..."
"/c/Program Files (x86)/cloudflared/cloudflared.exe" tunnel run chicken-stream &
TUNNEL_PID=$!
echo "Tunnel started (PID: $TUNNEL_PID)"

echo ""
echo "Chicken Stream is running!"
echo "  Local:  http://localhost:3000"
echo "  Public: https://sornigfarm.com"
echo ""
echo "Press Ctrl+C to stop both services"

# Wait and handle shutdown
trap "echo 'Stopping...'; kill $WEB_PID $TUNNEL_PID 2>/dev/null; exit" SIGINT SIGTERM
wait
