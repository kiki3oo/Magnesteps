const http = require('http');
const fs = require('fs');
const path = require('path');

const PORT = process.env.PORT || 5500;
const BASE_DIR = __dirname;
const ORDERS_FILE = path.join(BASE_DIR, 'orders.json');

// Ensure orders.json exists
if (!fs.existsSync(ORDERS_FILE)) {
  fs.writeFileSync(ORDERS_FILE, '[]');
}

const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon'
};

function getOrders() {
  try {
    const data = fs.readFileSync(ORDERS_FILE, 'utf8');
    return JSON.parse(data || '[]');
  } catch (e) {
    return [];
  }
}

function saveOrders(orders) {
  fs.writeFileSync(ORDERS_FILE, JSON.stringify(orders, null, 2), 'utf8');
}

const server = http.createServer((req, res) => {
  // CORS Headers
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    res.end();
    return;
  }

  const parsedUrl = new URL(req.url, `http://${req.headers.host}`);
  const pathname = parsedUrl.pathname;

  // ================= API ENDPOINTS =================
  if (pathname === '/api/orders') {
    if (req.method === 'GET') {
      const orders = getOrders();
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(orders));
      return;
    }

    if (req.method === 'POST') {
      let body = '';
      req.on('data', chunk => { body += chunk; });
      req.on('end', () => {
        try {
          const newOrder = JSON.parse(body);
          if (!newOrder.id) {
            newOrder.id = 'CMD-' + Date.now().toString().slice(-6);
          }
          if (!newOrder.date) {
            newOrder.date = new Date().toLocaleDateString('fr-FR');
            newOrder.time = new Date().toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' });
          }
          if (!newOrder.status) {
            newOrder.status = 'en_attente';
          }

          const orders = getOrders();
          const existingIdx = orders.findIndex(o => o.id === newOrder.id);
          if (existingIdx !== -1) {
            orders[existingIdx] = { ...orders[existingIdx], ...newOrder };
          } else {
            orders.unshift(newOrder);
          }
          saveOrders(orders);

          console.log(`[Order Saved] ${newOrder.id} - ${newOrder.name} (${newOrder.phone}) - ${newOrder.price} DH`);

          res.writeHead(201, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ success: true, order: newOrder }));
        } catch (e) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ success: false, error: e.message }));
        }
      });
      return;
    }

    if (req.method === 'PUT') {
      let body = '';
      req.on('data', chunk => { body += chunk; });
      req.on('end', () => {
        try {
          const { id, status } = JSON.parse(body);
          let orders = getOrders();
          orders = orders.map(o => o.id === id ? { ...o, status } : o);
          saveOrders(orders);

          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ success: true }));
        } catch (e) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ success: false, error: e.message }));
        }
      });
      return;
    }

    if (req.method === 'DELETE') {
      const id = parsedUrl.searchParams.get('id');
      if (id) {
        let orders = getOrders();
        orders = orders.filter(o => o.id !== id);
        saveOrders(orders);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: true }));
        return;
      }
    }
  }

  // ================= STATIC FILE SERVING =================
  let safePath = pathname === '/' ? '/index.html' : pathname;
  let filePath = path.join(BASE_DIR, safePath);

  // Security check: avoid directory traversal
  if (!filePath.startsWith(BASE_DIR)) {
    res.writeHead(403);
    res.end('Forbidden');
    return;
  }

  fs.stat(filePath, (err, stats) => {
    if (err || !stats.isFile()) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('404 Not Found');
      return;
    }

    const ext = path.extname(filePath).toLowerCase();
    const contentType = MIME_TYPES[ext] || 'application/octet-stream';

    res.writeHead(200, { 'Content-Type': contentType });
    fs.createReadStream(filePath).pipe(res);
  });
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`MagneSteps Server running on http://localhost:${PORT}`);
});
