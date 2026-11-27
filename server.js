const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

// ================= CONFIG (variables d'environnement) =================
const PORT = process.env.PORT || 5500;
const BASE_DIR = __dirname;
const DATA_DIR = process.env.DATA_DIR || path.join(BASE_DIR, 'data');
const ORDERS_FILE = path.join(DATA_DIR, 'orders.json');
const BLOCKLIST_FILE = path.join(DATA_DIR, 'blocklist.json');
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || '';
const ADMIN_ENABLED = ADMIN_PASSWORD.length >= 8;

const SANADOKOM_CONFIG = {
  webhookUrl: process.env.SANADOKOM_WEBHOOK_URL || 'https://app.rovanx.com/api/webhooks/orders',
  webhookSecret: process.env.SANADOKOM_WEBHOOK_SECRET || ''
};

// Les prix sont fixés ici, côté serveur : le navigateur ne décide jamais du prix
const PACKS = {
  1: { title: 'باك زوج واحد (للتجربة)', price: 199 },
  2: { title: 'باك 2 أزواج (الأكثر طلباً)', price: 299 },
  3: { title: 'باك العائلة (3 أزواج)', price: 399 }
};

const ALLOWED_STATUSES = ['en_attente', 'confirme', 'en_livraison', 'livre', 'annule'];

// Anti-fake orders (modifiables via variables d'environnement)
const MAX_ORDERS_PER_DEVICE_24H = Number(process.env.MAX_ORDERS_PER_DEVICE_24H) || 2;
const MAX_ORDERS_PER_PHONE_24H = Number(process.env.MAX_ORDERS_PER_PHONE_24H) || 1;
const MAX_ORDERS_PER_IP_24H = Number(process.env.MAX_ORDERS_PER_IP_24H) || 10;

if (!ADMIN_ENABLED) {
  console.warn('[SECURITE] ADMIN_PASSWORD absent ou trop court (min 8 caracteres) : le panneau admin est DESACTIVE.');
}
if (!SANADOKOM_CONFIG.webhookSecret) {
  console.warn("[Sanadokom] SANADOKOM_WEBHOOK_SECRET absent : les commandes ne seront pas envoyees a l'ERP.");
}

// ================= STOCKAGE =================
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
if (!fs.existsSync(ORDERS_FILE)) {
  // Migration depuis l'ancien emplacement (racine du projet)
  const legacy = path.join(BASE_DIR, 'orders.json');
  if (fs.existsSync(legacy)) {
    fs.copyFileSync(legacy, ORDERS_FILE);
    console.log('[Migration] orders.json copie vers', ORDERS_FILE);
  } else {
    fs.writeFileSync(ORDERS_FILE, '[]');
  }
}

function getOrders() {
  try {
    return JSON.parse(fs.readFileSync(ORDERS_FILE, 'utf8') || '[]');
  } catch (e) {
    console.error('[Orders] Lecture impossible:', e.message);
    return [];
  }
}

function saveOrders(orders) {
  const tmp = ORDERS_FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(orders, null, 2), 'utf8');
  fs.renameSync(tmp, ORDERS_FILE);
}

function getBlocklist() {
  try {
    const b = JSON.parse(fs.readFileSync(BLOCKLIST_FILE, 'utf8'));
    return { phones: b.phones || [], devices: b.devices || [], ips: b.ips || [] };
  } catch (e) {
    return { phones: [], devices: [], ips: [] };
  }
}

function saveBlocklist(b) {
  const tmp = BLOCKLIST_FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(b, null, 2), 'utf8');
  fs.renameSync(tmp, BLOCKLIST_FILE);
}

// Normalise un numero marocain : 0612345678 / +212612345678 -> 0612345678
function normPhone(p) {
  const d = String(p || '').replace(/\D/g, '');
  if (d.startsWith('212') && d.length === 12) return '0' + d.slice(3);
  return d;
}

function isBlocked(order, bl) {
  return (order.phone && bl.phones.includes(normPhone(order.phone))) ||
    (order.deviceId && bl.devices.includes(order.deviceId)) ||
    (order.ip && bl.ips.includes(order.ip));
}

// Raison de rejet silencieux d'une commande publique (null = OK)
function fraudReason(order, orders) {
  const bl = getBlocklist();
  if (isBlocked(order, bl)) return 'blocked';
  const since = Date.now() - 24 * 60 * 60 * 1000;
  const recent = orders.filter(o => o.timestamp && Date.parse(o.timestamp) > since);
  const phone = normPhone(order.phone);
  if (recent.filter(o => normPhone(o.phone) === phone).length >= MAX_ORDERS_PER_PHONE_24H) return 'duplicate-phone';
  if (order.deviceId && recent.filter(o => o.deviceId === order.deviceId).length >= MAX_ORDERS_PER_DEVICE_24H) return 'device-limit';
  if (recent.filter(o => o.ip === order.ip).length >= MAX_ORDERS_PER_IP_24H) return 'ip-limit';
  return null;
}

// Ajoute des indicateurs de fraude a chaque commande (pour le panneau admin)
function withFraudFlags(orders) {
  const bl = getBlocklist();
  const byDevice = {}, byIp = {}, byPhone = {}, cancelledPhones = new Set();
  orders.forEach(o => {
    if (o.deviceId) byDevice[o.deviceId] = (byDevice[o.deviceId] || 0) + 1;
    if (o.ip) byIp[o.ip] = (byIp[o.ip] || 0) + 1;
    const ph = normPhone(o.phone);
    if (ph) byPhone[ph] = (byPhone[ph] || 0) + 1;
    if (o.status === 'annule' && ph) cancelledPhones.add(ph);
  });
  return orders.map(o => ({
    ...o,
    flags: {
      blocked: Boolean(isBlocked(o, bl)),
      sameDevice: o.deviceId ? byDevice[o.deviceId] - 1 : 0,
      sameIp: o.ip ? byIp[o.ip] - 1 : 0,
      samePhone: (byPhone[normPhone(o.phone)] || 1) - 1,
      phoneCancelledBefore: o.status !== 'annule' && cancelledPhones.has(normPhone(o.phone))
    }
  }));
}

// ================= SECURITE =================
function isAdmin(req) {
  if (!ADMIN_ENABLED) return false;
  const given = String(req.headers['x-admin-key'] || '');
  const a = crypto.createHash('sha256').update(given).digest();
  const b = crypto.createHash('sha256').update(ADMIN_PASSWORD).digest();
  return crypto.timingSafeEqual(a, b);
}

// Limite : 5 commandes publiques par IP toutes les 10 minutes
const rateBuckets = new Map();
function rateLimited(ip) {
  const now = Date.now();
  const windowMs = 10 * 60 * 1000;
  const hits = (rateBuckets.get(ip) || []).filter(t => now - t < windowMs);
  hits.push(now);
  rateBuckets.set(ip, hits);
  if (rateBuckets.size > 5000) rateBuckets.clear();
  return hits.length > 5;
}

// Limite login admin : 10 essais ratés par IP toutes les 15 minutes
const loginFails = new Map();
function loginBlocked(ip) {
  const now = Date.now();
  const fails = (loginFails.get(ip) || []).filter(t => now - t < 15 * 60 * 1000);
  loginFails.set(ip, fails);
  return fails.length >= 10;
}
function recordLoginFail(ip) {
  const fails = loginFails.get(ip) || [];
  fails.push(Date.now());
  loginFails.set(ip, fails);
  if (loginFails.size > 5000) loginFails.clear();
}

// Derriere Easypanel (Traefik), le proxy AJOUTE la vraie IP a la fin de X-Forwarded-For.
// Les valeurs au debut peuvent etre inventees par le client : on prend donc la derniere.
// TRUSTED_PROXY_HOPS = nombre de proxys de confiance (1 = Traefik seul, 2 = Cloudflare + Traefik...)
const TRUSTED_PROXY_HOPS = Number(process.env.TRUSTED_PROXY_HOPS || 1);
function clientIp(req) {
  const direct = String(req.socket.remoteAddress || 'unknown').replace(/^::ffff:/, '');
  if (TRUSTED_PROXY_HOPS < 1) return direct;
  const list = String(req.headers['x-forwarded-for'] || '').split(',').map(x => x.trim()).filter(Boolean);
  if (!list.length) return direct;
  return list[Math.max(0, list.length - TRUSTED_PROXY_HOPS)].replace(/^::ffff:/, '');
}

function cleanText(v, max) {
  return String(v == null ? '' : v).replace(/[\u0000-\u001F<>]/g, ' ').trim().slice(0, max);
}

function readBody(req, res, cb) {
  let body = '';
  let tooBig = false;
  req.on('data', chunk => {
    if (tooBig) return;
    body += chunk;
    if (body.length > 20000) {
      tooBig = true;
      sendJson(res, 413, { success: false, error: 'Requete trop grande' });
      req.destroy();
    }
  });
  req.on('end', () => {
    if (tooBig) return;
    let data;
    try { data = JSON.parse(body || '{}'); }
    catch (e) { return sendJson(res, 400, { success: false, error: 'JSON invalide' }); }
    if (!data || typeof data !== 'object' || Array.isArray(data)) {
      return sendJson(res, 400, { success: false, error: 'JSON invalide' });
    }
    try { cb(data); }
    catch (e) {
      console.error('[API Error]', e.message);
      sendJson(res, 500, { success: false, error: 'Erreur serveur' });
    }
  });
}

function sendJson(res, code, obj) {
  if (res.headersSent) return;
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(obj));
}

function newOrderId() {
  return 'CMD-' + Date.now().toString().slice(-6) + crypto.randomBytes(2).toString('hex').toUpperCase();
}

// Construit une commande publique a partir des seuls champs autorises
function buildPublicOrder(input, ip, userAgent) {
  let count = parseInt(input.packCount, 10);
  if (!PACKS[count]) {
    // compatibilite : deduire le pack depuis le prix envoye
    const byPrice = Object.keys(PACKS).find(k => PACKS[k].price === Number(input.price));
    count = byPrice ? Number(byPrice) : 2;
  }
  const phone = cleanText(input.phone, 20).replace(/[\s.-]/g, '');
  if (!/^(0[5-7]\d{8}|\+?212[5-7]\d{8})$/.test(phone)) return { error: 'Numero de telephone invalide' };
  const name = cleanText(input.name, 80);
  const address = cleanText(input.address, 250);
  if (name.length < 2) return { error: 'Nom invalide' };
  if (address.length < 3) return { error: 'Adresse invalide' };

  const now = new Date();
  return {
    order: {
      id: newOrderId(),
      name,
      phone,
      address,
      pack: PACKS[count].title,
      packCount: count,
      price: PACKS[count].price,
      status: 'en_attente',
      utmSource: cleanText(input.utmSource, 100) || 'Landing Page',
      utmCampaign: cleanText(input.utmCampaign, 100) || null,
      adSet: cleanText(input.adSet, 100) || null,
      deviceId: /^[A-Za-z0-9-]{8,64}$/.test(String(input.deviceId || '')) ? String(input.deviceId) : null,
      ip,
      userAgent: cleanText(userAgent, 200),
      date: now.toLocaleDateString('fr-FR', { timeZone: 'Africa/Casablanca' }),
      time: now.toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit', timeZone: 'Africa/Casablanca' }),
      timestamp: now.toISOString()
    }
  };
}

// ================= ERP SANADOKOM =================
function forwardToSanadokom(order) {
  try {
    if (!SANADOKOM_CONFIG.webhookSecret || !SANADOKOM_CONFIG.webhookUrl) return;
    const url = new URL(SANADOKOM_CONFIG.webhookUrl);

    let quantity = Number(order.packCount) || 0;
    if (!quantity) {
      quantity = 1;
      if (order.pack && (order.pack.includes('زوجين') || order.pack.includes('2'))) quantity = 2;
      else if (order.pack && (order.pack.includes('3') || order.pack.includes('ثلاثة'))) quantity = 3;
    }
    const total = Number(order.price) || 199;

    const payload = JSON.stringify({
      webhookSecret: SANADOKOM_CONFIG.webhookSecret,
      customerName: order.name,
      customerPhone: order.phone,
      customerCity: order.city || order.address || 'Maroc',
      customerAddress: order.address || '',
      customerNote: `Pack: ${order.pack || 'Standard'} • CMD: ${order.id}`,
      totalAmount: total,
      items: [{
        sku: 'MAGNE-STEPS-01',
        productName: 'فرشات MagneSteps الأصلية',
        quantity,
        unitPrice: Math.round(total / quantity)
      }],
      source: order.utmSource || 'MagneSteps Landing Page',
      utmSource: order.utmSource || null,
      utmCampaign: order.utmCampaign || null,
      adSet: order.adSet || null
    });

    const isHttps = url.protocol === 'https:';
    const req = (isHttps ? https : http).request({
      hostname: url.hostname,
      port: url.port || (isHttps ? 443 : 80),
      path: url.pathname + url.search,
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) },
      timeout: 8000
    }, (res) => {
      res.resume();
      console.log(`[Sanadokom Sync] Order ${order.id} -> HTTP ${res.statusCode}`);
    });
    req.on('error', err => console.warn(`[Sanadokom Sync Error] Order ${order.id}:`, err.message));
    req.on('timeout', () => { req.destroy(); console.warn(`[Sanadokom Sync Timeout] Order ${order.id}`); });
    req.write(payload);
    req.end();
  } catch (err) {
    console.error('[Sanadokom Forward Exception]:', err.message);
  }
}

// ================= FICHIERS PUBLICS =================
const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon'
};
// Seuls ces fichiers JS sont publics (jamais server.js, api.php, orders.json...)
const PUBLIC_JS = new Set([]); // aucun fichier JS public pour l'instant

function isPublicPath(p) {
  if (p.split('/').some(seg => seg.startsWith('.'))) return false; // .git, .env, .htaccess...
  if (p.startsWith('/data/') || p.startsWith('/node_modules/')) return false;
  const ext = path.extname(p).toLowerCase();
  if (!MIME_TYPES[ext]) return false;
  if (ext === '.js' && !PUBLIC_JS.has(p)) return false;
  return true;
}

// ================= SERVEUR =================
const server = http.createServer((req, res) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  res.setHeader('X-Frame-Options', 'SAMEORIGIN');

  let parsedUrl, pathname;
  try {
    parsedUrl = new URL(req.url, 'http://localhost');
    pathname = decodeURIComponent(parsedUrl.pathname);
  } catch (e) {
    res.writeHead(400); res.end('Bad Request'); return;
  }

  if (pathname === '/api/orders') {
    const ip = clientIp(req);
    const triedAdmin = Boolean(req.headers['x-admin-key']);
    if (triedAdmin && loginBlocked(ip)) {
      return sendJson(res, 429, { success: false, error: 'Trop de tentatives, reessayez dans 15 minutes' });
    }
    const admin = isAdmin(req);
    if (triedAdmin && !admin) recordLoginFail(ip);

    if (req.method === 'POST') {
      return readBody(req, res, (input) => {
        const orders = getOrders();

        if (admin) {
          // Admin : ajout manuel / synchronisation (champs controles)
          const order = {
            ...input,
            id: cleanText(input.id, 40) || newOrderId(),
            name: cleanText(input.name, 80),
            phone: cleanText(input.phone, 20),
            address: cleanText(input.address, 250),
            pack: cleanText(input.pack, 100),
            price: Number(input.price) || 0,
            status: ALLOWED_STATUSES.includes(input.status) ? input.status : 'en_attente'
          };
          delete order.flags; // calcule par le serveur, jamais stocke
          const idx = orders.findIndex(o => o.id === order.id);
          if (idx !== -1) {
            orders[idx] = { ...orders[idx], ...order };
          } else {
            orders.unshift(order);
            forwardToSanadokom(order);
          }
          saveOrders(orders);
          return sendJson(res, 201, { success: true, order });
        }

        // Public : formulaire du site
        if (input.website || input.b_extra_hp) return sendJson(res, 201, { success: true }); // honeypot (bots)
        if (rateLimited(ip)) return sendJson(res, 429, { success: false, error: 'Trop de commandes, reessayez plus tard' });

        const built = buildPublicOrder(input, ip, req.headers['user-agent']);
        if (built.error) return sendJson(res, 400, { success: false, error: built.error });
        const order = built.order;

        // Fake orders : on repond "succes" sans enregistrer, pour ne pas alerter le fraudeur
        const reason = fraudReason(order, orders);
        if (reason) {
          console.log(`[Anti-fraude] Commande ignoree (${reason}) ip=${ip} device=${order.deviceId || '-'}`);
          return sendJson(res, 201, { success: true, order: { id: order.id, price: order.price, pack: order.pack } });
        }

        orders.unshift(order);
        saveOrders(orders);
        forwardToSanadokom(order);
        console.log(`[Order Saved] ${order.id} - ${order.price} DH`);
        // On ne renvoie au navigateur que le strict minimum
        return sendJson(res, 201, { success: true, order: { id: order.id, price: order.price, pack: order.pack } });
      });
    }

    // Lire / modifier / supprimer = admin uniquement
    if (!admin) return sendJson(res, 401, { success: false, error: 'Non autorise' });

    if (req.method === 'GET') return sendJson(res, 200, withFraudFlags(getOrders()));

    if (req.method === 'PUT') {
      return readBody(req, res, ({ id, status, notes }) => {
        const orders = getOrders();
        const o = orders.find(x => x.id === id);
        if (!o) return sendJson(res, 404, { success: false, error: 'Commande introuvable' });
        if (status !== undefined) {
          if (!ALLOWED_STATUSES.includes(status)) return sendJson(res, 400, { success: false, error: 'Statut invalide' });
          o.status = status;
        }
        if (notes !== undefined) o.notes = cleanText(notes, 500);
        saveOrders(orders);
        return sendJson(res, 200, { success: true });
      });
    }

    if (req.method === 'DELETE') {
      const id = parsedUrl.searchParams.get('id');
      if (!id) return sendJson(res, 400, { success: false, error: 'ID requis' });
      saveOrders(getOrders().filter(o => o.id !== id));
      return sendJson(res, 200, { success: true });
    }

    return sendJson(res, 405, { error: 'Methode non autorisee' });
  }

  // ================= BLOCKLIST (admin) =================
  // POST /api/block  { orderId, block: true|false, blockIp: true|false }
  // Bloque (ou debloque) le telephone et l'appareil de cette commande (+ l'IP si blockIp)
  if (pathname === '/api/block') {
    const ip = clientIp(req);
    if (req.headers['x-admin-key'] && loginBlocked(ip)) return sendJson(res, 429, { success: false, error: 'Trop de tentatives' });
    if (!isAdmin(req)) {
      if (req.headers['x-admin-key']) recordLoginFail(ip);
      return sendJson(res, 401, { success: false, error: 'Non autorise' });
    }
    if (req.method === 'GET') return sendJson(res, 200, getBlocklist());
    if (req.method !== 'POST') return sendJson(res, 405, { error: 'Methode non autorisee' });
    return readBody(req, res, ({ orderId, block, blockIp }) => {
      const orders = getOrders();
      const o = orders.find(x => x.id === orderId);
      if (!o) return sendJson(res, 404, { success: false, error: 'Commande introuvable' });
      const bl = getBlocklist();
      const items = [['phones', normPhone(o.phone)], ['devices', o.deviceId], ['ips', o.ip]];
      // Tous les numeros utilises depuis le meme appareil sont bloques/debloques ensemble
      if (o.deviceId) {
        orders.filter(x => x.deviceId === o.deviceId && x.phone)
          .forEach(x => items.push(['phones', normPhone(x.phone)]));
      }
      items.forEach(([key, val]) => {
        if (!val) return;
        if (block !== false) {
          if (key === 'ips' && !blockIp) return; // IP partagee possible (4G) : seulement si demande
          if (!bl[key].includes(val)) bl[key].push(val);
        } else {
          bl[key] = bl[key].filter(v => v !== val);
        }
      });
      saveBlocklist(bl);
      if (block !== false) {
        // Les commandes du meme telephone/appareil passent en "annule"
        const ph = normPhone(o.phone);
        orders.forEach(x => {
          if ((normPhone(x.phone) === ph || (o.deviceId && x.deviceId === o.deviceId)) && x.status === 'en_attente') x.status = 'annule';
        });
        saveOrders(orders);
      }
      return sendJson(res, 200, { success: true, blocked: block !== false });
    });
  }

  // ================= STATIC =================
  if (req.method !== 'GET' && req.method !== 'HEAD') { res.writeHead(405); res.end(); return; }

  const safePath = pathname === '/' ? '/index.html' : pathname;
  const filePath = path.join(BASE_DIR, safePath);

  if (!filePath.startsWith(BASE_DIR + path.sep) || !isPublicPath(safePath)) {
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('404 Not Found');
    return;
  }

  fs.stat(filePath, (err, stats) => {
    if (err || !stats.isFile()) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('404 Not Found');
      return;
    }
    const headers = { 'Content-Type': MIME_TYPES[path.extname(filePath).toLowerCase()] };
    if (safePath === '/admin.html') {
      headers['X-Robots-Tag'] = 'noindex, nofollow';
      headers['Cache-Control'] = 'no-store';
    }
    res.writeHead(200, headers);
    if (req.method === 'HEAD') return res.end();
    fs.createReadStream(filePath).pipe(res);
  });
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`MagneSteps Server running on http://localhost:${PORT}`);
});
