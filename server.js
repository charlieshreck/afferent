const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const pty = require('node-pty');
const { execSync } = require('child_process');
const path = require('path');
const crypto = require('crypto');

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

const PORT = process.env.PORT || 3456;
const AUTH_TOKEN = process.env.AUTH_TOKEN || crypto.randomBytes(32).toString('hex');

const activePtys = new Map();

function authenticate(req, res, next) {
  const t = req.headers['authorization']?.replace('Bearer ', '') || req.query.token;
  if (t !== AUTH_TOKEN) return res.status(401).json({ error: 'Unauthorized' });
  next();
}

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

function listScreenSessions() {
  try {
    const output = execSync('screen -ls 2>&1', { encoding: 'utf-8' });
    return parseScreenOutput(output);
  } catch (e) {
    return parseScreenOutput(e.stdout || '');
  }
}

function parseScreenOutput(output) {
  const sessions = [];
  const re = /(\d+)\.(\S+)\s+\(([^)]+)\)/g;
  let m;
  while ((m = re.exec(output)) !== null) {
    sessions.push({
      pid: m[1],
      name: m[2],
      fullName: `${m[1]}.${m[2]}`,
      state: m[3].toLowerCase().includes('attached') ? 'attached' : 'detached',
      connected: activePtys.has(m[2]) && activePtys.get(m[2]).clients.size > 0
    });
  }
  return sessions;
}

function attachToSession(sessionName) {
  if (activePtys.has(sessionName)) return activePtys.get(sessionName);

  const sessions = listScreenSessions();
  const match = sessions.find(s => s.name === sessionName || s.fullName === sessionName);
  if (!match) throw new Error(`Session "${sessionName}" not found. Available: ${sessions.map(s => s.name).join(', ')}`);

  // Sanitized environment - only pass necessary variables
  const sanitizedEnv = {
    TERM: 'xterm-256color',
    PATH: process.env.PATH,
    HOME: process.env.HOME,
    LANG: process.env.LANG || 'en_US.UTF-8',
    USER: process.env.USER || 'root',
  };

  const term = pty.spawn('screen', ['-x', match.fullName], {
    name: 'xterm-256color',
    cols: 100,
    rows: 30,
    cwd: process.env.HOME,
    env: sanitizedEnv
  });

  const session = {
    pty: term,
    clients: new Set(),
    buffer: [],
    bufferMaxChars: 80000
  };

  let bufferLen = 0;

  term.onData((data) => {
    session.buffer.push(data);
    bufferLen += data.length;
    while (bufferLen > session.bufferMaxChars && session.buffer.length > 1) {
      bufferLen -= session.buffer.shift().length;
    }
    for (const client of session.clients) {
      if (client.readyState === WebSocket.OPEN) {
        client.send(JSON.stringify({ type: 'output', data }));
      }
    }
  });

  term.onExit(({ exitCode }) => {
    console.log(`PTY for ${sessionName} exited (code ${exitCode})`);
    for (const client of session.clients) {
      if (client.readyState === WebSocket.OPEN) {
        client.send(JSON.stringify({ type: 'session_ended', session: sessionName }));
      }
    }
    activePtys.delete(sessionName);
  });

  activePtys.set(sessionName, session);
  return session;
}

app.get('/api/sessions', authenticate, (req, res) => {
  res.json({ sessions: listScreenSessions() });
});

const CTRL_MAP = {
  'ctrl+a': '\x01', 'ctrl+c': '\x03', 'ctrl+d': '\x04',
  'ctrl+l': '\x0C', 'ctrl+z': '\x1A', 'escape': '\x1B',
  'tab': '\t', 'enter': '\r',
  'up': '\x1B[A', 'down': '\x1B[B', 'left': '\x1B[C', 'right': '\x1B[D',
  'screen-next': '\x01n', 'screen-prev': '\x01p',
  'screen-list': '\x01"', 'screen-detach': '\x01d', 'screen-copy': '\x01[',
};

// Ping-pong heartbeat for connection health
const heartbeatInterval = setInterval(() => {
  wss.clients.forEach((ws) => {
    if (ws.isAlive === false) return ws.terminate();
    ws.isAlive = false;
    ws.ping();
  });
}, 30000);

wss.on('close', () => clearInterval(heartbeatInterval));

wss.on('connection', (ws, req) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  if (url.searchParams.get('token') !== AUTH_TOKEN) {
    ws.send(JSON.stringify({ type: 'error', message: 'Unauthorized' }));
    ws.close(1008, 'Unauthorized');
    return;
  }

  ws.isAlive = true;
  ws.on('pong', () => { ws.isAlive = true; });

  let currentSession = null;

  ws.on('message', (raw) => {
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }

    switch (msg.type) {
      case 'attach': {
        if (currentSession && activePtys.has(currentSession)) {
          activePtys.get(currentSession).clients.delete(ws);
        }
        try {
          const session = attachToSession(msg.session);
          session.clients.add(ws);
          currentSession = msg.session;
          if (session.buffer.length > 0) {
            ws.send(JSON.stringify({ type: 'buffer', data: session.buffer.join('') }));
          }
          ws.send(JSON.stringify({ type: 'attached', session: msg.session }));
        } catch (e) {
          ws.send(JSON.stringify({ type: 'error', message: e.message }));
        }
        break;
      }
      case 'input': {
        const s = activePtys.get(currentSession);
        if (s) s.pty.write(msg.data);
        break;
      }
      case 'control': {
        const s = activePtys.get(currentSession);
        if (!s) break;
        const seq = CTRL_MAP[msg.key];
        if (seq) s.pty.write(seq);
        else if (msg.raw) s.pty.write(msg.raw);
        break;
      }
      case 'resize': {
        const s = activePtys.get(currentSession);
        if (s && msg.cols > 0 && msg.rows > 0) s.pty.resize(msg.cols, msg.rows);
        break;
      }
      case 'list': {
        ws.send(JSON.stringify({ type: 'sessions', sessions: listScreenSessions() }));
        break;
      }
    }
  });

  ws.on('close', () => {
    if (currentSession && activePtys.has(currentSession)) {
      activePtys.get(currentSession).clients.delete(ws);
    }
  });
});

server.listen(PORT, '0.0.0.0', () => {
  const sessions = listScreenSessions();
  console.log(`\n⬡  Afferent`);
  console.log(`   Port: ${PORT}`);
  console.log(`   Token: ${AUTH_TOKEN}\n`);
  console.log(`   Found ${sessions.length} screen session(s):`);
  sessions.forEach(s => console.log(`     ${s.name} (${s.state})`));
  if (sessions.length === 0) console.log(`     (none – start your screen sessions first)`);
  console.log(`\n   Connect: https://synapse.kernow.io\n`);
});
