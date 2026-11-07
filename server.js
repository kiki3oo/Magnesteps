const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');

const PORT = process.env.PORT || 5500;
const BASE_DIR = __dirname;
const ORDERS_FILE = path.join(BASE_DIR, 'orders.json');

// Sanadokom ERP Webhook Integration
const SANADOKOM_CONFIG = {
  webhookUrl: process.env.SANADOKOM_WEBHOOK_URL || 'https://app.rovanx.com/api/webhooks/orders',
  webhookSecret: process.env.SANADOKOM_WEBHOOK_SECRET || 'whsec_magnesteps_maroc_2026',
  enabled: true
};

function forwardToSanadokom(order) {
  try {
    if (!SANADOKOM_CONFIG.enabled || !SANADOKOM_CONFIG.webhookUrl) return;

    const url = new URL(SANADOKOM_CONFIG.webhookUrl);

    let quantity = 1;
    if (order.pack && (order.pack.includes('زوجين') || order.pack.includes('2'))) {
      quantity = 2;
    } else if (order.pack && (order.pack.includes('3') || order.pack.includes('ثلاثة'))) {
      quantity = 3;
    }

    const payload = JSON.stringify({
      webhookSecret: SANADOKOM_CONFIG.webhookSecret,
      customerName: order.name,
      customerPhone: order.phone,
      customerCity: order.city || order.address || 'Maroc',
      customerAddress: order.address || '',
      customerNote: `Pack: ${order.pack || 'Standard'} • CMD: ${order.id}`,
      totalAmount: Number(order.price) || 199,
      items: [
        {
          sku: 'MAGNE-STEPS-01',
          productName: 'فرشات MagneSteps الطبية الأصلية',
          quantity: quantity,
          unitPrice: Math.round((Number(order.price) || 199) / quantity)
        }
      ],
      source: order.utmSource || 'MagneSteps Landing Page',
      utmSource: order.utmSource || null,
      utmCampaign: order.utmCampaign || null,
      adSet: order.adSet || null
    });

    const isHttps = url.protocol === 'https:';
    const client = isHttps ? https : http;

    const req = client.request({
      hostname: url.hostname,
      port: url.port || (isHttps ? 443 : 80),
      path: url.pathname + url.search,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(payload)
      },
      timeout: 8000
    }, (res) => {
      let data = '';
      res.on('data', chunk => { data += chunk; });
      res.on('end', () => {
        console.log(`[Sanadokom Sync] Order ${order.id} -> HTTP ${res.statusCode}:`, data);
      });
    });

    req.on('error', (err) => {
      console.warn(`[Sanadokom Sync Error] Order ${order.id}:`, err.message);
    });

    req.on('timeout', () => {
      req.destroy();
      console.warn(`[Sanadokom Sync Timeout] Order ${order.id}`);
    });

    req.write(payload);
    req.end();
  } catch (err) {
    console.error('[Sanadokom Forward Exception]:', err.message);
  }
}

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
          
          // Forward directly to Sanadokom COD ERP platform
          forwardToSanadokom(newOrder);

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
