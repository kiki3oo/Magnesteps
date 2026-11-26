<?php
// MagneSteps API (version Apache / cPanel / Hostinger)
// La configuration secrete est dans config.php (jamais dans Git). Voir config.example.php
header('Content-Type: application/json; charset=utf-8');
header('Cache-Control: no-store');
header('X-Content-Type-Options: nosniff');

if (file_exists(__DIR__ . '/config.php')) {
    require __DIR__ . '/config.php';
}
$ADMIN_PASSWORD = defined('ADMIN_PASSWORD') ? ADMIN_PASSWORD : (getenv('ADMIN_PASSWORD') ?: '');
$WEBHOOK_URL    = defined('SANADOKOM_WEBHOOK_URL') ? SANADOKOM_WEBHOOK_URL : (getenv('SANADOKOM_WEBHOOK_URL') ?: 'https://app.rovanx.com/api/webhooks/orders');
$WEBHOOK_SECRET = defined('SANADOKOM_WEBHOOK_SECRET') ? SANADOKOM_WEBHOOK_SECRET : (getenv('SANADOKOM_WEBHOOK_SECRET') ?: '');

$dataDir = __DIR__ . '/data';
$ordersFile = $dataDir . '/orders.json';
$rateFile = $dataDir . '/ratelimit.json';

if (!is_dir($dataDir)) {
    mkdir($dataDir, 0750, true);
}
if (!file_exists($dataDir . '/.htaccess')) {
    file_put_contents($dataDir . '/.htaccess', "Require all denied\n");
}
if (!file_exists($ordersFile)) {
    $legacy = __DIR__ . '/orders.json';
    file_put_contents($ordersFile, file_exists($legacy) ? file_get_contents($legacy) : '[]');
}

$PACKS = [
    1 => ['title' => 'باك زوج واحد (للتجربة)', 'price' => 199],
    2 => ['title' => 'باك 2 أزواج (الأكثر طلباً)', 'price' => 299],
    3 => ['title' => 'باك العائلة (3 أزواج)', 'price' => 399],
];
$ALLOWED_STATUSES = ['en_attente', 'confirme', 'en_livraison', 'livre', 'annule'];

function respond($code, $data) {
    http_response_code($code);
    echo json_encode($data, JSON_UNESCAPED_UNICODE);
    exit;
}

function getOrders($file) {
    $data = json_decode(@file_get_contents($file), true);
    return is_array($data) ? $data : [];
}

function saveOrders($file, $orders) {
    file_put_contents($file, json_encode($orders, JSON_PRETTY_PRINT | JSON_UNESCAPED_UNICODE), LOCK_EX);
}

function cleanText($v, $max) {
    $v = preg_replace('/[\x00-\x1F<>]/u', ' ', (string)($v ?? ''));
    return mb_substr(trim($v), 0, $max);
}

function clientIp() {
    return $_SERVER['REMOTE_ADDR'] ?? 'unknown';
}

// Compteur simple par IP (fichier). Retourne true si la limite est depassee.
function hitLimit($file, $key, $max, $windowSec) {
    $now = time();
    $fp = fopen($file, 'c+');
    if (!$fp) return false;
    flock($fp, LOCK_EX);
    $all = json_decode(stream_get_contents($fp), true);
    if (!is_array($all)) $all = [];
    foreach ($all as $k => $times) {
        $all[$k] = array_values(array_filter($times, function ($t) use ($now, $windowSec) { return $now - $t < $windowSec; }));
        if (!$all[$k]) unset($all[$k]);
    }
    $all[$key][] = $now;
    $over = count($all[$key]) > $max;
    ftruncate($fp, 0);
    rewind($fp);
    fwrite($fp, json_encode($all));
    flock($fp, LOCK_UN);
    fclose($fp);
    return $over;
}

function countHits($file, $key, $windowSec) {
    $all = json_decode(@file_get_contents($file), true);
    if (!is_array($all) || empty($all[$key])) return 0;
    $now = time();
    return count(array_filter($all[$key], function ($t) use ($now, $windowSec) { return $now - $t < $windowSec; }));
}

function forwardToSanadokom($order, $url, $secret) {
    if (!$secret || !$url || !function_exists('curl_init')) return;
    $qty = (int)($order['packCount'] ?? 0);
    if ($qty < 1) {
        $qty = 1;
        $pack = $order['pack'] ?? '';
        if (mb_strpos($pack, 'زوجين') !== false || strpos($pack, '2') !== false) $qty = 2;
        else if (strpos($pack, '3') !== false || mb_strpos($pack, 'ثلاثة') !== false) $qty = 3;
    }
    $total = floatval($order['price'] ?? 199);
    $payload = json_encode([
        'webhookSecret' => $secret,
        'customerName' => $order['name'] ?? '',
        'customerPhone' => $order['phone'] ?? '',
        'customerCity' => $order['city'] ?? ($order['address'] ?? 'Maroc'),
        'customerAddress' => $order['address'] ?? '',
        'customerNote' => 'Pack: ' . ($order['pack'] ?? 'Standard') . ' • CMD: ' . ($order['id'] ?? ''),
        'totalAmount' => $total,
        'items' => [[
            'sku' => 'MAGNE-STEPS-01',
            'productName' => 'فرشات MagneSteps الأصلية',
            'quantity' => $qty,
            'unitPrice' => round($total / $qty)
        ]],
        'source' => $order['utmSource'] ?? 'MagneSteps Landing Page',
        'utmSource' => $order['utmSource'] ?? null,
        'utmCampaign' => $order['utmCampaign'] ?? null,
        'adSet' => $order['adSet'] ?? null
    ], JSON_UNESCAPED_UNICODE);
    try {
        $ch = curl_init($url);
        curl_setopt($ch, CURLOPT_POSTFIELDS, $payload);
        curl_setopt($ch, CURLOPT_HTTPHEADER, ['Content-Type: application/json']);
        curl_setopt($ch, CURLOPT_RETURNTRANSFER, true);
        curl_setopt($ch, CURLOPT_TIMEOUT, 5);
        @curl_exec($ch);
        curl_close($ch);
    } catch (\Throwable $e) {}
}

function newOrderId() {
    return 'CMD-' . substr((string)time(), -6) . strtoupper(bin2hex(random_bytes(2)));
}

// ================= AUTH ADMIN =================
$ip = clientIp();
$givenKey = (string)($_SERVER['HTTP_X_ADMIN_KEY'] ?? '');
$adminEnabled = strlen($ADMIN_PASSWORD) >= 8;
$isAdmin = false;
if ($givenKey !== '') {
    if (countHits($rateFile, 'login:' . $ip, 900) >= 10) {
        respond(429, ['success' => false, 'error' => 'Trop de tentatives, reessayez dans 15 minutes']);
    }
    $isAdmin = $adminEnabled && hash_equals(hash('sha256', $ADMIN_PASSWORD), hash('sha256', $givenKey));
    if (!$isAdmin) hitLimit($rateFile, 'login:' . $ip, 1000, 900);
}

$method = $_SERVER['REQUEST_METHOD'];

function readJsonBody() {
    $input = file_get_contents('php://input', false, null, 0, 20000);
    $data = json_decode($input, true);
    if (!is_array($data)) respond(400, ['success' => false, 'error' => 'JSON invalide']);
    return $data;
}

// ================= POST : nouvelle commande =================
if ($method === 'POST') {
    $input = readJsonBody();
    $orders = getOrders($ordersFile);

    if ($isAdmin) {
        $order = array_merge($input, [
            'id' => cleanText($input['id'] ?? '', 40) ?: newOrderId(),
            'name' => cleanText($input['name'] ?? '', 80),
            'phone' => cleanText($input['phone'] ?? '', 20),
            'address' => cleanText($input['address'] ?? '', 250),
            'pack' => cleanText($input['pack'] ?? '', 100),
            'price' => floatval($input['price'] ?? 0),
            'status' => in_array($input['status'] ?? '', $ALLOWED_STATUSES, true) ? $input['status'] : 'en_attente',
        ]);
        $found = false;
        foreach ($orders as $i => $o) {
            if (($o['id'] ?? '') === $order['id']) {
                $orders[$i] = array_merge($o, $order);
                $found = true;
                break;
            }
        }
        if (!$found) {
            array_unshift($orders, $order);
            forwardToSanadokom($order, $WEBHOOK_URL, $WEBHOOK_SECRET);
        }
        saveOrders($ordersFile, $orders);
        respond(201, ['success' => true, 'order' => $order]);
    }

    // Public (formulaire du site)
    if (!empty($input['website']) || !empty($input['b_extra_hp'])) {
        respond(201, ['success' => true]); // honeypot
    }
    if (hitLimit($rateFile, 'order:' . $ip, 5, 600)) {
        respond(429, ['success' => false, 'error' => 'Trop de commandes, reessayez plus tard']);
    }

    $count = (int)($input['packCount'] ?? 0);
    if (!isset($PACKS[$count])) {
        $count = 2;
        foreach ($PACKS as $k => $p) {
            if ($p['price'] == floatval($input['price'] ?? 0)) { $count = $k; break; }
        }
    }
    $phone = preg_replace('/[\s.\-]/', '', cleanText($input['phone'] ?? '', 20));
    if (!preg_match('/^(0[5-7]\d{8}|\+?212[5-7]\d{8})$/', $phone)) {
        respond(400, ['success' => false, 'error' => 'Numero de telephone invalide']);
    }
    $name = cleanText($input['name'] ?? '', 80);
    $address = cleanText($input['address'] ?? '', 250);
    if (mb_strlen($name) < 2) respond(400, ['success' => false, 'error' => 'Nom invalide']);
    if (mb_strlen($address) < 3) respond(400, ['success' => false, 'error' => 'Adresse invalide']);

    $tz = new DateTimeZone('Africa/Casablanca');
    $now = new DateTime('now', $tz);
    $order = [
        'id' => newOrderId(),
        'name' => $name,
        'phone' => $phone,
        'address' => $address,
        'pack' => $PACKS[$count]['title'],
        'packCount' => $count,
        'price' => $PACKS[$count]['price'],
        'status' => 'en_attente',
        'utmSource' => cleanText($input['utmSource'] ?? '', 100) ?: 'Landing Page',
        'utmCampaign' => cleanText($input['utmCampaign'] ?? '', 100) ?: null,
        'adSet' => cleanText($input['adSet'] ?? '', 100) ?: null,
        'date' => $now->format('d/m/Y'),
        'time' => $now->format('H:i'),
        'timestamp' => gmdate('c'),
    ];
    array_unshift($orders, $order);
    saveOrders($ordersFile, $orders);
    forwardToSanadokom($order, $WEBHOOK_URL, $WEBHOOK_SECRET);
    respond(201, ['success' => true, 'order' => ['id' => $order['id'], 'price' => $order['price'], 'pack' => $order['pack']]]);
}

// ================= Le reste = admin uniquement =================
if (!$isAdmin) {
    respond(401, ['success' => false, 'error' => 'Non autorise']);
}

if ($method === 'GET') {
    $orders = getOrders($ordersFile);
    if (isset($_GET['export']) && $_GET['export'] === 'csv') {
        header('Content-Type: text/csv; charset=utf-8');
        header('Content-Disposition: attachment; filename="commandes-magnesteps.csv"');
        $output = fopen('php://output', 'w');
        fprintf($output, chr(0xEF) . chr(0xBB) . chr(0xBF));
        fputcsv($output, ['ID', 'Date', 'Heure', 'Nom', 'Telephone', 'Ville / Adresse', 'Offre', 'Prix (DH)', 'Statut']);
        foreach ($orders as $o) {
            $row = [$o['id'] ?? '', $o['date'] ?? '', $o['time'] ?? '', $o['name'] ?? '', $o['phone'] ?? '', $o['address'] ?? '', $o['pack'] ?? '', $o['price'] ?? '', $o['status'] ?? ''];
            // Protection contre l'injection de formules Excel
            $row = array_map(function ($c) { $c = (string)$c; return preg_match('/^[=+\-@]/', $c) ? "'" . $c : $c; }, $row);
            fputcsv($output, $row);
        }
        fclose($output);
        exit;
    }
    respond(200, $orders);
}

if ($method === 'PUT') {
    $data = readJsonBody();
    if (empty($data['id'])) respond(400, ['success' => false, 'error' => 'ID requis']);
    $orders = getOrders($ordersFile);
    foreach ($orders as &$o) {
        if (($o['id'] ?? '') === $data['id']) {
            if (isset($data['status'])) {
                if (!in_array($data['status'], $ALLOWED_STATUSES, true)) respond(400, ['success' => false, 'error' => 'Statut invalide']);
                $o['status'] = $data['status'];
            }
            if (isset($data['notes'])) $o['notes'] = cleanText($data['notes'], 500);
            unset($o);
            saveOrders($ordersFile, $orders);
            respond(200, ['success' => true]);
        }
    }
    unset($o);
    respond(404, ['success' => false, 'error' => 'Commande introuvable']);
}

if ($method === 'DELETE') {
    $id = $_GET['id'] ?? '';
    if ($id === '') respond(400, ['success' => false, 'error' => 'ID requis']);
    $orders = array_values(array_filter(getOrders($ordersFile), function ($o) use ($id) {
        return ($o['id'] ?? '') !== $id;
    }));
    saveOrders($ordersFile, $orders);
    respond(200, ['success' => true]);
}

respond(405, ['error' => 'Methode non autorisee']);
