# Afferent

*Afferent (adj.): Carrying signals toward the central nervous system*

Mobile PWA for accessing Claude Code screen sessions from your Android phone with swipe typing support. Your phone becomes an afferent pathway to Claude's brain.

## Architecture

```
Android Phone (Gboard swipe typing)
  -> https://afferent.lab
  -> AdGuard DNS rewrite -> OPNsense LAN IP
  -> Caddy (TLS termination, reverse proxy)
  -> Debian LXC:3456 (Node.js WebSocket server)
  -> node-pty attaches via `screen -x`
```

## Features

- **Session discovery**: Auto-discovers existing screen sessions via `screen -ls`
- **Multi-attach**: Uses `screen -x` so you can connect alongside SSH
- **Swipe typing**: Native textarea input supports Gboard swipe
- **Control keys**: Scrollable bar for ^C, ^D, ^Z, Tab, arrows, screen combos
- **Reconnection**: Auto-reconnects on phone sleep/wake with output replay
- **PWA**: Install to home screen for standalone app experience

## Installation

### 1. Install Dependencies (Debian LXC)

```bash
# Node.js 20
curl -fsSL https://deb.nodesource.com/setup_20.x | bash -
apt-get install -y nodejs build-essential python3 screen

# App dependencies
cd /home/afferent
npm install
```

### 2. Generate Auth Token

```bash
openssl rand -hex 32
```

Save this token - you'll need it for the systemd service and phone login.

### 3. Configure systemd Service

```bash
# Edit the service file and replace REPLACE_WITH_GENERATED_TOKEN
vim afferent.service

# Install and start
cp afferent.service /etc/systemd/system/
systemctl daemon-reload
systemctl enable --now afferent
```

### 4. AdGuard DNS Rewrite (OPNsense)

- Domain: `afferent.lab`
- Answer: `10.10.0.1` (OPNsense LAN IP where Caddy runs)

### 5. Caddy Reverse Proxy (OPNsense)

Add to Caddyfile:

```
afferent.lab {
    reverse_proxy <DEBIAN-LXC-IP>:3456
    tls internal
}
```

### 6. Android CA Trust

1. Get Caddy's root cert: `/var/lib/caddy/.local/share/caddy/pki/authorities/local/root.crt`
2. Transfer to Android
3. Settings -> Security -> Encryption & credentials -> Install a certificate -> CA certificate

### 7. Install PWA

1. Open `https://afferent.lab` in Chrome on Android
2. Enter your auth token
3. Chrome menu -> Add to Home screen
4. Launch from home screen

## Usage

- Sessions appear as tabs at the top
- Type in the bottom textarea (swipe typing works)
- Hit Enter or the send button to submit
- Use control bar for ^C, ^D, arrows, etc.
- Screen-specific combos: ^A, ^An (next), ^Ap (prev), ^A" (list)

## Files

- `server.js` - Node.js WebSocket server with node-pty
- `public/index.html` - PWA frontend with xterm.js
- `public/manifest.json` - PWA manifest
- `afferent.service` - systemd unit file

## Security

- Token-based authentication (32-byte hex)
- Token stored in localStorage (not in manifest URL)
- Sanitized PTY environment (no service secrets leaked)
- HTTPS via Caddy with internal CA
- Read/attach only - cannot create screen sessions

## Etymology

In neuroscience, **afferent neurons** carry sensory information *toward* the brain. This app is your afferent pathway - carrying your input toward Claude Code running on the server.

## Known Limitations

- Multi-client resize: Last client to resize wins
- iOS: Not tested, Android PWA focused
- Session creation: Discovery only, start sessions via SSH first
