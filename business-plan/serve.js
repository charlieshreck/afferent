const http = require('http');
const fs = require('fs');
const path = require('path');

const PORT = 4590;
const DIR = __dirname;
const SESSIONS_DIR = path.join(DIR, 'scoping-sessions');

const USERS = {
  'chaz': 'H4ckwh1z',
  'noosh': 'afferent1c',
  'sean': 'afferent1c',
  'zara': 'afferent1c',
};

const ROUTES = {
  // Landing page
  '/': 'index.html',
  '/index.html': 'index.html',
  '/canvas': 'canvas.html',
  '/canvas.html': 'canvas.html',
  '/map-bot-preview': 'map-bot-preview.html',
  '/map-bot-preview.html': 'map-bot-preview.html',
  // Current plan pages
  '/how-it-works': 'how-it-works.html',
  '/how-it-works.html': 'how-it-works.html',
  '/the-map': 'the-map.html',
  '/the-map.html': 'the-map.html',
  '/deliverables': 'deliverables.html',
  '/deliverables.html': 'deliverables.html',
  '/financial-plan': 'financial-plan.html',
  '/financial-plan.html': 'financial-plan.html',
  '/go-to-market': 'go-to-market.html',
  '/go-to-market.html': 'go-to-market.html',
  '/delivery-roadmap': 'delivery-roadmap.html',
  '/delivery-roadmap.html': 'delivery-roadmap.html',
  '/pricing': 'pricing.html',
  '/pricing.html': 'pricing.html',
  '/competitive-landscape': 'competitive-landscape.html',
  '/competitive-landscape.html': 'competitive-landscape.html',
  '/service-management': 'service-management.html',
  '/service-management.html': 'service-management.html',
  // Client-facing presentation (April 2026)
  '/presentation': 'presentation/index.html',
  '/presentation/': 'presentation/index.html',
  '/presentation/premise': 'presentation/premise.html',
  '/presentation/security': 'presentation/security.html',
  '/presentation/value': 'presentation/value.html',
  '/presentation/engagement': 'presentation/engagement.html',
  '/presentation/story': 'presentation/story.html',
  // Scoping & engagement (April 2026)
  '/scoping-document': 'scoping-document.html',
  '/scoping-document.html': 'scoping-document.html',
  '/scoping': 'scoping-document.html',
  '/scoping-form': 'scoping-form.html',
  '/scoping-form.html': 'scoping-form.html',
  '/project-report': 'project-report.html',
  '/project-report.html': 'project-report.html',
  // Sales & meeting prep (April 2026)
  '/how-it-actually-works': 'how-it-actually-works.html',
  '/how-it-actually-works.html': 'how-it-actually-works.html',
  '/playbook': 'playbook-template.html',
  '/playbook.html': 'playbook-template.html',
  '/playbook-template': 'playbook-template.html',
  '/first-meeting-guide': 'first-meeting-guide.html',
  '/first-meeting-guide.html': 'first-meeting-guide.html',
  '/canvas-v2': 'canvas-v2.html',
  '/canvas-v2.html': 'canvas-v2.html',
  // Specs
  '/approvals-spec': 'approvals-spec.html',
  '/approvals-spec.html': 'approvals-spec.html',
  '/approvals': 'approvals-spec.html',
  // Delivery
  '/delivery-framework': 'delivery-framework.html',
  '/delivery-framework.html': 'delivery-framework.html',
  // Client scoping sessions
  '/scoping/dhp-family': 'scoping-sessions/dhp-family.html',
  '/scoping/dhp-family.html': 'scoping-sessions/dhp-family.html',
  '/scoping/dhp-family-email': 'scoping-sessions/dhp-family-email.html',
  // Archive (accessible but not linked)
  '/archive/todo': 'archive/todo.html',
  '/archive/health-report': 'archive/health-report.html',
  '/archive/competitors': 'archive/competitors.html',
  '/archive/security': 'archive/security.html',
  '/archive/security-whitepaper': 'archive/security-whitepaper.html',
  '/archive/security-questionnaire': 'archive/security-questionnaire.html',
  '/archive/on-network': 'archive/on-network.html',
  '/archive/architecture': 'archive/architecture.html',
  '/archive/methodology': 'archive/methodology.html',
  '/archive/automation': 'archive/automation.html',
  '/archive/pricing-strategy': 'archive/pricing-strategy.html',
};

function checkAuth(req) {
  const auth = req.headers.authorization;
  if (!auth || !auth.startsWith('Basic ')) return false;
  const decoded = Buffer.from(auth.slice(6), 'base64').toString();
  const [user, pass] = decoded.split(':');
  return USERS[user] === pass;
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', c => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks).toString()));
    req.on('error', reject);
  });
}

function jsonResponse(res, code, data) {
  const body = JSON.stringify(data);
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': Buffer.byteLength(body) });
  res.end(body);
}

function sanitiseFilename(s) {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 60);
}

const server = http.createServer(async (req, res) => {
  if (!checkAuth(req)) {
    res.writeHead(401, {
      'WWW-Authenticate': 'Basic realm="Afferentic Business Plan"',
      'Content-Type': 'text/plain'
    });
    res.end('Authentication required');
    return;
  }

  const url = req.url.split('?')[0];

  // ==========================================
  // Scoping session API
  // ==========================================

  // POST /api/scoping — save a session
  if (req.method === 'POST' && url === '/api/scoping') {
    try {
      const body = await readBody(req);
      const data = JSON.parse(body);
      if (!data.engagement || !data.engagement.client) {
        jsonResponse(res, 400, { error: 'engagement.client is required' });
        return;
      }
      const client = sanitiseFilename(data.engagement.client);
      const date = new Date().toISOString().slice(0, 10);
      const filename = `${date}-${client}.json`;
      data._saved = new Date().toISOString();
      fs.writeFileSync(path.join(SESSIONS_DIR, filename), JSON.stringify(data, null, 2));
      jsonResponse(res, 200, { ok: true, filename });
    } catch (e) {
      jsonResponse(res, 500, { error: e.message });
    }
    return;
  }

  // GET /api/scoping — list all sessions
  if (req.method === 'GET' && url === '/api/scoping') {
    try {
      const files = fs.readdirSync(SESSIONS_DIR).filter(f => f.endsWith('.json')).sort().reverse();
      const sessions = files.map(f => {
        const data = JSON.parse(fs.readFileSync(path.join(SESSIONS_DIR, f)));
        return {
          filename: f,
          client: data.engagement?.client || 'Unknown',
          domain: data.engagement?.domain || '',
          date: data.engagement?.date || f.slice(0, 10),
          taskCount: (data.tasks || []).length,
          saved: data._saved
        };
      });
      jsonResponse(res, 200, sessions);
    } catch (e) {
      jsonResponse(res, 500, { error: e.message });
    }
    return;
  }

  // GET /api/scoping/:filename — load a specific session
  if (req.method === 'GET' && url.startsWith('/api/scoping/')) {
    const filename = url.split('/api/scoping/')[1];
    if (!filename || filename.includes('..') || !filename.endsWith('.json')) {
      jsonResponse(res, 400, { error: 'Invalid filename' });
      return;
    }
    const filePath = path.join(SESSIONS_DIR, filename);
    if (!fs.existsSync(filePath)) {
      jsonResponse(res, 404, { error: 'Session not found' });
      return;
    }
    try {
      const data = JSON.parse(fs.readFileSync(filePath));
      jsonResponse(res, 200, data);
    } catch (e) {
      jsonResponse(res, 500, { error: e.message });
    }
    return;
  }

  // ==========================================
  // Downloadable files
  // ==========================================

  if (url === '/download/financial-model.xlsx') {
    const xlsxPath = path.join(__dirname, '..', 'afferentic-financial-model.xlsx');
    fs.readFile(xlsxPath, (err, data) => {
      if (err) { res.writeHead(404); res.end('File not found'); return; }
      res.writeHead(200, {
        'Content-Type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
        'Content-Disposition': 'attachment; filename="Afferentic-Financial-Model.xlsx"',
        'Content-Length': data.length
      });
      res.end(data);
    });
    return;
  }

  if (url === '/download/delivery-roadmap.md') {
    const mdPath = path.join(__dirname, '..', 'afferentic-delivery-roadmap.md');
    fs.readFile(mdPath, (err, data) => {
      if (err) { res.writeHead(404); res.end('File not found'); return; }
      res.writeHead(200, {
        'Content-Type': 'text/markdown; charset=utf-8',
        'Content-Disposition': 'attachment; filename="Afferentic-Delivery-Roadmap.md"',
        'Content-Length': data.length
      });
      res.end(data);
    });
    return;
  }

  if (url === '/download/scoping-document.html') {
    const scopePath = path.join(__dirname, 'scoping-document.html');
    fs.readFile(scopePath, (err, data) => {
      if (err) { res.writeHead(404); res.end('File not found'); return; }
      res.writeHead(200, {
        'Content-Type': 'text/html; charset=utf-8',
        'Content-Disposition': 'attachment; filename="Afferentic-Scoping-Document-Template.html"',
        'Content-Length': data.length
      });
      res.end(data);
    });
    return;
  }

  if (url === '/download/go-to-market.md') {
    const mdPath = path.join(__dirname, '..', 'afferentic-go-to-market.md');
    fs.readFile(mdPath, (err, data) => {
      if (err) { res.writeHead(404); res.end('File not found'); return; }
      res.writeHead(200, {
        'Content-Type': 'text/markdown; charset=utf-8',
        'Content-Disposition': 'attachment; filename="Afferentic-Go-To-Market.md"',
        'Content-Length': data.length
      });
      res.end(data);
    });
    return;
  }

  // ==========================================
  // Static pages
  // ==========================================

  // ==========================================
  // Engine — dynamic routes
  // ==========================================
  if (url === '/engine' || url === '/engine/') {
    fs.readFile(path.join(DIR, 'engine/index.html'), (err, data) => {
      if (err) { res.writeHead(500); res.end('engine missing'); return; }
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(data);
    });
    return;
  }
  if (url === '/engine/prospects' || url === '/engine/prospects/') {
    fs.readFile(path.join(DIR, 'engine/prospects/index.html'), (err, data) => {
      if (err) { res.writeHead(500); res.end('prospects page not generated yet'); return; }
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(data);
    });
    return;
  }
  if (url.startsWith('/engine/prospects/')) {
    const slug = url.replace(/^\/engine\/prospects\//, '').replace(/\/$/, '').replace(/[^a-z0-9-]/gi, '');
    const filePath = path.join(DIR, 'engine/prospects', `${slug}.html`);
    if (fs.existsSync(filePath)) {
      fs.readFile(filePath, (err, data) => {
        if (err) { res.writeHead(500); res.end('error loading prospect page'); return; }
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(data);
      });
      return;
    }
    res.writeHead(404); res.end('Prospect not found'); return;
  }
  if (url === '/engine/data/prospects.json') {
    fs.readFile(path.join(DIR, 'engine/data/prospects.json'), (err, data) => {
      if (err) { res.writeHead(404); res.end('no data yet'); return; }
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(data);
    });
    return;
  }

  const file = ROUTES[url];
  if (file) {
    fs.readFile(path.join(DIR, file), (err, data) => {
      if (err) {
        res.writeHead(500);
        res.end('Error loading page');
        return;
      }
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(data);
    });
  } else {
    res.writeHead(404);
    res.end('Not found');
  }
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`Afferentic Business Plan serving on port ${PORT} (auth enabled)`);
});
