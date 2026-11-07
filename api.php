<?php
header('Content-Type: application/json; charset=utf-8');
header('Access-Control-Allow-Origin: *');
header('Access-Control-Allow-Methods: GET, POST, PUT, DELETE, OPTIONS');
header('Access-Control-Allow-Headers: Content-Type');

if ($_SERVER['REQUEST_METHOD'] === 'OPTIONS') {
    http_response_code(204);
    exit;
}

$ordersFile = __DIR__ . '/orders.json';

if (!file_exists($ordersFile)) {
    file_put_contents($ordersFile, '[]');
}

function getOrders($file) {
    $content = @file_get_contents($file);
    $data = json_decode($content, true);
    return is_array($data) ? $data : [];
}

function saveOrders($file, $orders) {
    file_put_contents($file, json_encode($orders, JSON_PRETTY_PRINT | JSON_UNESCAPED_UNICODE));
}

$method = $_SERVER['REQUEST_METHOD'];

if ($method === 'GET') {
    // Export CSV if requested
    if (isset($_GET['export']) && $_GET['export'] === 'csv') {
        $orders = getOrders($ordersFile);
        header('Content-Type: text/csv; charset=utf-8');
        header('Content-Disposition: attachment; filename="commandes-magnesteps.csv"');
        $output = fopen('php://output', 'w');
        fprintf($output, chr(0xEF).chr(0xBB).chr(0xBF)); // BOM for Excel Arabic
        fputcsv($output, ['ID', 'Date', 'Heure', 'Nom', 'Telephone', 'Ville / Adresse', 'Offre', 'Prix (DH)', 'Statut']);
        foreach ($orders as $o) {
            fputcsv($output, [
                $o['id'] ?? '',
                $o['date'] ?? '',
                $o['time'] ?? '',
                $o['name'] ?? '',
                $o['phone'] ?? '',
                $o['address'] ?? '',
                $o['pack'] ?? '',
                $o['price'] ?? '',
                $o['status'] ?? ''
            ]);
        }
        fclose($output);
        exit;
    }

    echo json_encode(getOrders($ordersFile));
    exit;
}

if ($method === 'POST') {
    $input = file_get_contents('php://input');
    $order = json_decode($input, true);

    if (!$order) {
        http_response_code(400);
        echo json_encode(['success' => false, 'error' => 'Invalid JSON']);
        exit;
    }

    if (empty($order['id'])) {
        $order['id'] = 'CMD-' . substr(time(), -6);
    }
    if (empty($order['date'])) {
        $order['date'] = date('d/m/Y');
        $order['time'] = date('H:i');
    }
    if (empty($order['status'])) {
        $order['status'] = 'en_attente';
    }

    $orders = getOrders($ordersFile);
    $existingIndex = -1;
    foreach ($orders as $idx => $o) {
        if (isset($o['id']) && $o['id'] === $order['id']) {
            $existingIndex = $idx;
            break;
        }
    }

    if ($existingIndex !== -1) {
        $orders[$existingIndex] = array_merge($orders[$existingIndex], $order);
    } else {
        array_unshift($orders, $order);
    }

    saveOrders($ordersFile, $orders);

    // Forward to Sanadokom COD Platform
    try {
        $ch = curl_init('https://app.rovanx.com/api/webhooks/orders');
        $qty = 1;
        if (!empty($order['pack'])) {
            if (stripos($order['pack'], 'زوجين') !== false || stripos($order['pack'], '2') !== false) $qty = 2;
            else if (stripos($order['pack'], '3') !== false || stripos($order['pack'], 'ثلاثة') !== false) $qty = 3;
        }
        $payload = json_encode([
            'webhookSecret' => 'whsec_magnesteps_maroc_2026',
            'customerName' => $order['name'] ?? '',
            'customerPhone' => $order['phone'] ?? '',
            'customerCity' => $order['city'] ?? ($order['address'] ?? 'Maroc'),
            'customerAddress' => $order['address'] ?? '',
            'customerNote' => 'Pack: ' . ($order['pack'] ?? 'Standard') . ' • CMD: ' . ($order['id'] ?? ''),
            'totalAmount' => floatval($order['price'] ?? 199),
            'items' => [
                [
                    'sku' => 'MAGNE-STEPS-01',
                    'productName' => 'فرشات MagneSteps الطبية الأصلية',
                    'quantity' => $qty,
                    'unitPrice' => round(floatval($order['price'] ?? 199) / $qty)
                ]
            ],
            'source' => $order['utmSource'] ?? 'MagneSteps Landing Page'
        ]);
        curl_setopt($ch, CURLOPT_POSTFIELDS, $payload);
        curl_setopt($ch, CURLOPT_HTTPHEADER, ['Content-Type: application/json']);
        curl_setopt($ch, CURLOPT_RETURNTRANSFER, true);
        curl_setopt($ch, CURLOPT_TIMEOUT, 5);
        @curl_exec($ch);
        curl_close($ch);
    } catch (\Throwable $e) {}

    http_response_code(201);
    echo json_encode(['success' => true, 'order' => $order]);
    exit;
}

if ($method === 'PUT') {
    $input = file_get_contents('php://input');
    $data = json_decode($input, true);

    if (!$data || empty($data['id'])) {
        http_response_code(400);
        echo json_encode(['success' => false, 'error' => 'Order ID required']);
        exit;
    }

    $orders = getOrders($ordersFile);
    $updated = false;
    foreach ($orders as &$o) {
        if (isset($o['id']) && $o['id'] === $data['id']) {
            if (isset($data['status'])) $o['status'] = $data['status'];
            if (isset($data['notes'])) $o['notes'] = $data['notes'];
            $updated = true;
            break;
        }
    }

    if ($updated) {
        saveOrders($ordersFile, $orders);
        echo json_encode(['success' => true]);
    } else {
        http_response_code(404);
        echo json_encode(['success' => false, 'error' => 'Order not found']);
    }
    exit;
}

if ($method === 'DELETE') {
    $id = $_GET['id'] ?? '';
    if (empty($id)) {
        $input = file_get_contents('php://input');
        $data = json_decode($input, true);
        $id = $data['id'] ?? '';
    }

    if (empty($id)) {
        http_response_code(400);
        echo json_encode(['success' => false, 'error' => 'Order ID required']);
        exit;
    }

    $orders = getOrders($ordersFile);
    $orders = array_values(array_filter($orders, function($o) use ($id) {
        return ($o['id'] ?? '') !== $id;
    }));

    saveOrders($ordersFile, $orders);
    echo json_encode(['success' => true]);
    exit;
}

http_response_code(405);
echo json_encode(['error' => 'Method not allowed']);
