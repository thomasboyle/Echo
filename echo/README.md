# Echo — Self-Hosted Communications

## Requirements
- Python 3.11+ (for server)
- Bun 1.0+ and Rust (for client development)

## Server Setup
```bash
pip install -r requirements.txt
python server.py
```
Server runs on `0.0.0.0:8000`. Share your local IP with clients (e.g. `192.168.1.x:8000`).

**Testing voice chat over the internet**

1. Expose the server so the other user can reach it. Easiest for testing: use a tunnel.
   - **Option A – ngrok**: Install [ngrok](https://ngrok.com), then run `ngrok http 8000` (with the Echo server already running). Copy the HTTPS URL (e.g. `https://abc123.ngrok-free.app`).
   - **Option B – Port forwarding**: On your router, forward TCP port 8000 to your PC’s local IP. Use your public IP (e.g. from whatismyip.com) as the server address, e.g. `http://YOUR_PUBLIC_IP:8000`.

2. You and the other user both use the **same** server URL in the app (login screen). For ngrok use the full URL including `https://`; for port forwarding use `http://YOUR_PUBLIC_IP:8000`.

3. Create or join the same server in the app, then both join the same voice channel. WebRTC uses Google’s STUN server for NAT traversal; if voice fails between two different networks, you may need a TURN server (advanced).

## Client Development
```bash
bun install
bunx tauri dev
```

## Build Distributable Client
```bash
bunx tauri build
```
Output: `src-tauri/target/release/bundle/`

To use a custom app icon, add `src-tauri/icons/icon.png` and set `"icon": ["icons/icon.png"]` in `src-tauri/tauri.conf.json` under `bundle`.
