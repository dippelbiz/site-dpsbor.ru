require('dotenv').config();
const express = require('express');
const { Pool } = require('pg');

const app = express();
app.use(express.json());
app.use(express.static('public'));

// ==================== CORS ====================
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Headers', 'Origin, X-Requested-With, Content-Type, Accept');
  if (req.method === 'OPTIONS') {
    res.sendStatus(200);
  } else {
    next();
  }
});

// ==================== ПОДКЛЮЧЕНИЕ К БАЗЕ ДАННЫХ ====================
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
  connectionTimeoutMillis: 10000,
  idleTimeoutMillis: 10000,
  max: 5,
  min: 0,
  allowExitOnIdle: true
});

pool.connect((err, client, release) => {
  if (err) {
    console.error('❌ Ошибка подключения к базе данных:', err.message);
  } else {
    console.log('✅ Подключение к базе данных установлено');
    release();
  }
});

// ==================== WAzzup ИНТЕГРАЦИЯ ====================
const WAZZUP_API_KEY = process.env.WAZZUP_API_KEY;

// Webhook для приёма сообщений от Wazzup (с парсингом номера заказа)
app.post('/api/webhook/wazzup', async (req, res) => {
  console.log('📨 Получено сообщение от Wazzup:', JSON.stringify(req.body, null, 2));
  
  try {
    const data = req.body;
    const { channel, sender_id, sender_name, sender_phone, message_text, direction, message_id } = data;
    
    let orderId = null;
    let orderNumber = null;
    
    // Парсим номер заказа из сообщения
    if (message_text) {
      // Регулярное выражение для поиска номера заказа (А1, D2, Ю3 и т.д.)
      const match = message_text.match(/ЗАКАЗ\s*№?\s*([A-Za-zА-Яа-я]{1,3}\d+)/i) ||
                    message_text.match(/Заказ\s*№?\s*([A-Za-zА-Яа-я]{1,3}\d+)/i) ||
                    message_text.match(/№\s*([A-Za-zА-Яа-я]{1,3}\d+)/i);
      if (match) {
        orderNumber = match[1];
        console.log(`🔍 Найден номер заказа в сообщении: ${orderNumber}`);
        
        // Находим заказ в БД
        const orderResult = await pool.query(
          'SELECT id FROM orders WHERE order_number = $1',
          [orderNumber]
        );
        if (orderResult.rows.length > 0) {
          orderId = orderResult.rows[0].id;
          console.log(`✅ Заказ найден: ID=${orderId}`);
          
          // Сохраняем ID чата в заказе
          await pool.query(
            'UPDATE orders SET wazzup_chat_id = $1 WHERE id = $2 AND wazzup_chat_id IS NULL',
            [message_id, orderId]
          );
        } else {
          console.log(`⚠️ Заказ с номером ${orderNumber} не найден`);
        }
      }
    }
    
    // Сохраняем сообщение в БД
    await pool.query(`
      INSERT INTO chat_messages (order_id, channel, external_id, sender_id, sender_name, sender_phone, message_text, direction, created_at)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, NOW())
    `, [orderId, channel, message_id, sender_id, sender_name, sender_phone, message_text, direction]);
    
    if (orderId) {
      console.log(`🔔 Сообщение привязано к заказу #${orderId}`);
    }
    
    res.status(200).json({ success: true });
  } catch (err) {
    console.error('Wazzup webhook error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Получение чата по заказу
app.get('/api/manager/order/:orderId/chat', checkManagerAuth, async (req, res) => {
  const { orderId } = req.params;
  try {
    const messages = await pool.query(`
      SELECT * FROM chat_messages 
      WHERE order_id = $1 
      ORDER BY created_at ASC
    `, [orderId]);
    res.json({ messages: messages.rows });
  } catch (err) {
    console.error('Chat error:', err);
    res.status(500).json({ error: 'Database error' });
  }
});

// ==================== ВСПОМОГАТЕЛЬНЫЕ ФУНКЦИИ ====================
function normalizeNumber(value) {
  if (value === undefined || value === null || value === '') return null;
  let str = String(value).trim();
  str = str.replace(',', '.');
  const parts = str.split('.');
  if (parts.length > 2) str = parts[0] + '.' + parts.slice(1).join('');
  const num = parseFloat(str);
  return isNaN(num) ? null : num;
}

// ==================== ГЛАВНАЯ СТРАНИЦА ====================
app.get('/', (req, res) => {
  res.sendFile(__dirname + '/public/website/index.html');
});

// ==================== API ТОВАРОВ И КОРЗИНЫ ====================

app.get('/api/products', async (req, res) => {
  try {
    const products = await pool.query(`
      SELECT p.id, p.name, p.description, p.image, p.category,
             json_agg(json_build_object(
               'id', v.id,
               'name', v.name,
               'price', v.price,
               'weight_kg', v.weight_kg,
               'is_active', v.is_active
             ) ORDER BY v.sort_order) as variants
      FROM products p
      LEFT JOIN variants v ON p.id = v.product_id
      WHERE v.is_active = true
      GROUP BY p.id
      ORDER BY p.id
    `);
    res.json(products.rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Database error' });
  }
});

// Получение корзины пользователя
app.get('/api/cart/:userId', async (req, res) => {
  const userId = parseInt(req.params.userId, 10);
  try {
    const result = await pool.query(`
      SELECT 
        c.product_id, c.variant_id, c.quantity, c.price_at_time,
        p.name,
        v.name as variant_name, v.price
      FROM carts c
      JOIN products p ON c.product_id = p.id
      LEFT JOIN variants v ON c.variant_id = v.id
      WHERE c.user_id = $1
    `, [userId]);

    const items = result.rows.map(row => ({
      productId: row.product_id,
      variantId: row.variant_id,
      quantity: row.quantity,
      priceAtTime: row.price_at_time,
      name: row.name,
      variantName: row.variant_name,
      price: row.price
    }));

    res.json({ userId, items });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Database error' });
  }
});

// Добавление в корзину
app.post('/api/cart/add', async (req, res) => {
  const { userId, productId, variantId, quantity } = req.body;
  const numUserId = parseInt(userId, 10);
  const numProductId = parseInt(productId, 10);
  const numVariantId = parseInt(variantId, 10);
  const numQuantity = parseInt(quantity, 10);

  try {
    const variant = await pool.query(
      'SELECT price, is_active FROM variants WHERE id = $1 AND product_id = $2',
      [numVariantId, numProductId]
    );
    if (variant.rows.length === 0) return res.status(400).json({ error: 'Invalid variant' });
    if (!variant.rows[0].is_active) return res.status(400).json({ error: 'Variant is not active' });
    const price = variant.rows[0].price;

    await pool.query(`
      INSERT INTO carts (user_id, product_id, variant_id, quantity, price_at_time)
      VALUES ($1, $2, $3, $4, $5)
      ON CONFLICT (user_id, product_id, variant_id)
      DO UPDATE SET quantity = carts.quantity + EXCLUDED.quantity
    `, [numUserId, numProductId, numVariantId, numQuantity, price]);

    res.json({ success: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Database error' });
  }
});

// Обновление количества
app.post('/api/cart/update', async (req, res) => {
  const { userId, productId, variantId, quantity } = req.body;
  const numUserId = parseInt(userId, 10);
  const numProductId = parseInt(productId, 10);
  const numVariantId = parseInt(variantId, 10);
  const numQuantity = parseInt(quantity, 10);

  if (numQuantity < 0) return res.status(400).json({ error: 'Quantity must be non-negative' });

  try {
    if (numQuantity === 0) {
      await pool.query(
        'DELETE FROM carts WHERE user_id = $1 AND product_id = $2 AND variant_id = $3',
        [numUserId, numProductId, numVariantId]
      );
    } else {
      await pool.query(`
        UPDATE carts SET quantity = $1
        WHERE user_id = $2 AND product_id = $3 AND variant_id = $4
      `, [numQuantity, numUserId, numProductId, numVariantId]);
    }
    res.json({ success: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Database error' });
  }
});

// Удаление из корзины
app.delete('/api/cart/remove', async (req, res) => {
  const { userId, productId, variantId } = req.body;
  try {
    await pool.query(
      'DELETE FROM carts WHERE user_id = $1 AND product_id = $2 AND variant_id = $3',
      [userId, productId, variantId]
    );
    res.json({ success: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Database error' });
  }
});

// Получение заказов пользователя (для покупателя)
app.get('/api/orders/:userId', async (req, res) => {
  const userId = parseInt(req.params.userId, 10);
  try {
    const result = await pool.query(
      'SELECT * FROM orders WHERE user_telegram_id = $1 ORDER BY id DESC',
      [userId]
    );
    const orders = result.rows.map(order => {
      if (order.items) order.items = JSON.parse(order.items);
      if (order.contact) order.contact = JSON.parse(order.contact);
      return order;
    });
    res.json(orders);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Database error' });
  }
});

// Получение точек самовывоза
app.get('/api/pickup-locations', async (req, res) => {
  try {
    const result = await pool.query(
      'SELECT district, address, sort_order FROM pickup_locations ORDER BY district, sort_order'
    );
    res.json(result.rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Database error' });
  }
});

async function generateOrderNumber(prefix) {
  if (!prefix) prefix = 'X';
  if (prefix.length > 3) prefix = prefix.substring(0, 3);
  try {
    const result = await pool.query(
      `SELECT order_number FROM orders WHERE order_number LIKE $1 ORDER BY id DESC LIMIT 1`,
      [prefix + '%']
    );
    if (result.rows.length > 0) {
      const lastNum = result.rows[0].order_number.substring(prefix.length);
      const num = parseInt(lastNum) || 0;
      return prefix + (num + 1);
    } else {
      return prefix + '1';
    }
  } catch (err) {
    console.error('Ошибка при генерации номера заказа:', err);
    return prefix + '1';
  }
}

// ==================== СОЗДАНИЕ ЗАКАЗА ====================
app.post('/api/order', async (req, res) => {
  console.log('='.repeat(60));
  console.log('🔵 НАЧАЛО ОБРАБОТКИ ЗАКАЗА');
  console.log('='.repeat(60));
  
  try {
    const data = req.body;
    console.log('📦 Полученные данные:', JSON.stringify(data, null, 2));
    
    if (!data) {
      console.error('❌ Нет данных в запросе');
      return res.status(400).json({ error: 'No data' });
    }

    const userId = data.userId;
    const items = data.items;
    const total = data.total;
    const contact = data.contact;
    const request_id = data.requestId;

    console.log(`👤 Пользователь: ${userId}`);
    console.log(`🏠 Адрес: ${contact?.address}`);
    console.log(`🚚 Тип доставки: ${contact?.deliveryType}`);
    console.log(`💰 Сумма: ${total}`);
    console.log(`💬 Мессенджер: ${contact?.messenger}`);

    if (!userId || !items || !total || !contact?.address) {
      console.error('❌ Отсутствуют обязательные поля');
      return res.status(400).json({ error: 'Missing required fields' });
    }

    if (request_id) {
      console.log(`🔍 Проверка request_id: ${request_id}`);
      const existing = await pool.query('SELECT id FROM orders WHERE request_id = $1', [request_id]);
      if (existing.rows.length > 0) {
        console.log(`⚠️ Дублирующийся запрос с requestId ${request_id} отклонён`);
        return res.status(409).json({ error: 'Duplicate order' });
      }
      console.log('✅ Request_id уникален');
    }

    let seller_id = null;
    let prefix = null;
    
    if (contact.deliveryType === 'pickup') {
      console.log(`🔍 Поиск точки самовывоза: ${contact.address}`);
      const addrResult = await pool.query(
        'SELECT seller_id, prefix FROM pickup_locations WHERE address = $1', 
        [contact.address]
      );
      if (addrResult.rows.length === 0) {
        console.error(`❌ Адрес не найден: ${contact.address}`);
        return res.status(400).json({ error: 'Invalid pickup address' });
      }
      seller_id = addrResult.rows[0].seller_id;
      prefix = addrResult.rows[0].prefix;
      
      console.log(`✅ Точка найдена: продавец=${seller_id}, префикс=${prefix}`);
      
      if (!prefix) {
        const seller = await pool.query('SELECT name FROM users WHERE id = $1', [seller_id]);
        const seller_name = seller.rows[0]?.name || 'X';
        prefix = seller_name[0].toUpperCase();
      }
    } else {
      seller_id = 6;
      prefix = 'D';
    }

    console.log(`✅ Определён продавец ID: ${seller_id}, префикс: ${prefix}`);

    let total_sum = 0;
    const orderItems = items.map(item => {
      const itemTotal = item.priceAtTime * item.quantity;
      total_sum += itemTotal;
      return {
        productId: item.productId,
        variantId: item.variantId,
        name: item.name,
        variantName: item.variantName,
        quantity: item.quantity,
        price: item.priceAtTime,
      };
    });

    console.log('📝 Состав заказа:', orderItems);
    console.log(`💰 Итого: ${total_sum}`);

    const order_number = await generateOrderNumber(prefix);
    console.log(`✅ Сгенерирован номер заказа: ${order_number}`);

    const itemsJson = JSON.stringify(orderItems);
    const contactJson = JSON.stringify(contact);

    console.log('💾 Сохранение заказа в БД...');
    const insertResult = await pool.query(`
      INSERT INTO orders (order_number, user_telegram_id, seller_id, items, total, contact, status, request_id, created_at)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, NOW())
      RETURNING id
    `, [order_number, userId, seller_id, itemsJson, total_sum, contactJson, 'new', request_id]);

    const orderId = insertResult.rows[0].id;
    console.log(`✅ Заказ сохранён с ID: ${orderId}`);

    // Очищаем корзину
    await pool.query('DELETE FROM carts WHERE user_id = $1', [userId]);
    console.log('✅ Корзина очищена');

    console.log('='.repeat(60));
    console.log('✅ ЗАКАЗ УСПЕШНО ОБРАБОТАН');
    console.log('='.repeat(60));
    
    res.status(200).json({ orderNumber: order_number });

  } catch (err) {
    console.error('❌ КРИТИЧЕСКАЯ ОШИБКА В /api/order:');
    console.error(err);
    console.error('='.repeat(60));
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ==================== ПАНЕЛЬ УПРАВЛЕНИЯ (MANAGER) ====================

const validTokens = new Map();

app.post('/api/manager/auth', async (req, res) => {
  const { telegram_id, name } = req.body;
  console.log('Auth attempt:', { telegram_id, name });
  
  try {
    const result = await pool.query(
      'SELECT * FROM users WHERE telegram_id = $1 AND is_active = true',
      [telegram_id]
    );
    
    if (result.rows.length === 0) {
      return res.status(403).json({ success: false, message: 'Доступ запрещён. Обратитесь к администратору.' });
    }
    
    const user = result.rows[0];
    const token = Buffer.from(`${user.id}:${Date.now()}`).toString('base64');
    validTokens.set(token, { userId: user.id, role: user.role, expires: Date.now() + 86400000 });
    
    res.json({ success: true, token: token, name: user.name, role: user.role });
  } catch (err) {
    console.error('Auth error:', err);
    res.status(500).json({ success: false, message: 'Ошибка сервера' });
  }
});

async function checkManagerAuth(req, res, next) {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  
  const token = authHeader.substring(7);
  const tokenData = validTokens.get(token);
  
  if (!tokenData || tokenData.expires < Date.now()) {
    validTokens.delete(token);
    return res.status(401).json({ error: 'Token expired' });
  }
  
  req.userId = tokenData.userId;
  req.userRole = tokenData.role;
  next();
}

// Получение информации о текущем пользователе
app.get('/api/manager/me', checkManagerAuth, async (req, res) => {
  const result = await pool.query('SELECT id, name, role FROM users WHERE id = $1', [req.userId]);
  res.json(result.rows[0]);
});

// Получение дашборда
app.get('/api/manager/dashboard', checkManagerAuth, async (req, res) => {
  try {
    const userResult = await pool.query('SELECT name, role FROM users WHERE id = $1', [req.userId]);
    if (userResult.rows.length === 0) return res.status(404).json({ error: 'User not found' });
    const user = userResult.rows[0];
    
    let statsQuery;
    let statsParams = [];
    
    if (user.role === 'admin') {
      statsQuery = `
        SELECT 
          COUNT(CASE WHEN status = 'new' THEN 1 END) as new_orders,
          COUNT(CASE WHEN status = 'processing' THEN 1 END) as processing_orders,
          COUNT(CASE WHEN status = 'completed' THEN 1 END) as completed_count,
          COALESCE(SUM(CASE WHEN status = 'completed' THEN total END), 0) as revenue
        FROM orders
      `;
    } else {
      statsQuery = `
        SELECT 
          COUNT(CASE WHEN status = 'new' THEN 1 END) as new_orders,
          COUNT(CASE WHEN status = 'processing' THEN 1 END) as processing_orders,
          COUNT(CASE WHEN status = 'completed' THEN 1 END) as completed_count,
          COALESCE(SUM(CASE WHEN status = 'completed' THEN total END), 0) as revenue
        FROM orders
        WHERE seller_id = $1
      `;
      statsParams = [req.userId];
    }
    
    const statsResult = await pool.query(statsQuery, statsParams);
    const stats = statsResult.rows[0];
    
    res.json({
      user: { name: user.name, role: user.role },
      stats: {
        new_orders: parseInt(stats.new_orders) || 0,
        processing_orders: parseInt(stats.processing_orders) || 0,
        completed_count: parseInt(stats.completed_count) || 0,
        revenue: parseInt(stats.revenue) || 0
      }
    });
  } catch (err) {
    console.error('Dashboard error:', err);
    res.status(500).json({ error: 'Database error' });
  }
});

// Получение списка заказов для менеджера
app.get('/api/manager/orders', checkManagerAuth, async (req, res) => {
  try {
    const { status, page = 1, limit = 20 } = req.query;
    const offset = (page - 1) * limit;
    
    let query = `
      SELECT id, order_number, contact, items, total, status, seller_id, user_telegram_id, wazzup_chat_id, created_at, completed_at
      FROM orders
    `;
    const params = [];
    
    if (status && status !== 'all') {
      query += ` WHERE status = $${params.length + 1}`;
      params.push(status);
    }
    
    query += ` ORDER BY created_at DESC LIMIT $${params.length + 1} OFFSET $${params.length + 2}`;
    params.push(limit, offset);
    
    const result = await pool.query(query, params);
    const orders = result.rows.map(order => ({
      id: order.id,
      order_number: order.order_number,
      contact: typeof order.contact === 'string' ? JSON.parse(order.contact) : order.contact,
      items: typeof order.items === 'string' ? JSON.parse(order.items) : order.items,
      total: order.total,
      status: order.status,
      seller_id: order.seller_id,
      user_telegram_id: order.user_telegram_id,
      wazzup_chat_id: order.wazzup_chat_id,
      created_at: order.created_at,
      completed_at: order.completed_at
    }));
    
    res.json({ orders });
  } catch (err) {
    console.error('Orders error:', err);
    res.status(500).json({ error: 'Database error' });
  }
});

// Обновление статуса заказа
app.put('/api/manager/order/:id', checkManagerAuth, async (req, res) => {
  const { id } = req.params;
  const { status } = req.body;
  
  const allowedStatuses = ['new', 'processing', 'completed', 'cancelled'];
  if (!allowedStatuses.includes(status)) return res.status(400).json({ error: 'Invalid status' });
  
  try {
    await pool.query(
      'UPDATE orders SET status = $1, completed_at = CASE WHEN $1 = \'completed\' THEN NOW() ELSE completed_at END WHERE id = $2',
      [status, id]
    );
    res.json({ success: true });
  } catch (err) {
    console.error('Update order error:', err);
    res.status(500).json({ error: 'Database error' });
  }
});

// Взять заказ в работу
app.put('/api/manager/order/:id/take', checkManagerAuth, async (req, res) => {
  const { id } = req.params;
  try {
    const orderResult = await pool.query(
      'SELECT user_telegram_id, order_number FROM orders WHERE id = $1 AND status = $2',
      [id, 'new']
    );
    if (orderResult.rows.length === 0) {
      return res.status(404).json({ error: 'Заказ не найден или уже в работе' });
    }
    
    const order = orderResult.rows[0];
    
    await pool.query('BEGIN');
    
    await pool.query(
      'UPDATE orders SET status = $1, seller_id = $2 WHERE id = $3',
      ['processing', req.userId, id]
    );
    
    await pool.query(
      'UPDATE users SET active_chat_order_id = $1 WHERE telegram_id = $2',
      [id, order.user_telegram_id]
    );
    
    await pool.query('COMMIT');
    
    res.json({ success: true });
  } catch (err) {
    await pool.query('ROLLBACK');
    console.error('Take order error:', err);
    res.status(500).json({ error: 'Database error' });
  }
});

// Завершить заказ
app.put('/api/manager/order/:id/complete', checkManagerAuth, async (req, res) => {
  const { id } = req.params;
  try {
    const orderResult = await pool.query(
      'SELECT order_number, user_telegram_id, contact FROM orders WHERE id = $1 AND status = $2',
      [id, 'processing']
    );
    if (orderResult.rows.length === 0) {
      return res.status(404).json({ error: 'Заказ не найден или не в работе' });
    }
    
    const order = orderResult.rows[0];
    const contact = order.contact;
    const phone = contact.phone;
    const messenger = contact.messenger || 'telegram';
    
    await pool.query('BEGIN');
    
    await pool.query(
      'UPDATE orders SET status = $1, completed_at = NOW() WHERE id = $2',
      ['completed', id]
    );
    
    await pool.query(
      'UPDATE users SET active_chat_order_id = NULL WHERE telegram_id = $1',
      [order.user_telegram_id]
    );
    
    await pool.query('COMMIT');
    
    // Отправляем уведомление клиенту
    if (WAZZUP_API_KEY && phone && phone !== '0000000000') {
      const notification = `✅ Ваш заказ №${order.order_number} завершён! Спасибо за покупку. Диалог закрыт. Вы можете сделать новый заказ на сайте dpsbor.ru`;
      
      await fetch('https://api.wazzup24.com/v3/messages', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${WAZZUP_API_KEY}`
        },
        body: JSON.stringify({
          channel: messenger,
          recipient: phone,
          text: notification
        })
      }).catch(err => console.error('Ошибка отправки уведомления:', err));
    }
    
    res.json({ success: true });
  } catch (err) {
    await pool.query('ROLLBACK');
    console.error('Complete order error:', err);
    res.status(500).json({ error: 'Database error' });
  }
});

// Получить информацию о заказе
app.get('/api/manager/order/:id', checkManagerAuth, async (req, res) => {
  const { id } = req.params;
  try {
    const result = await pool.query('SELECT * FROM orders WHERE id = $1', [id]);
    if (result.rows.length === 0) return res.status(404).json({ error: 'Order not found' });
    
    const order = result.rows[0];
    order.items = typeof order.items === 'string' ? JSON.parse(order.items) : order.items;
    order.contact = typeof order.contact === 'string' ? JSON.parse(order.contact) : order.contact;
    
    res.json({ order });
  } catch (err) {
    console.error('Get order error:', err);
    res.status(500).json({ error: 'Database error' });
  }
});

// ==================== СКЛАД (РАСШИРЕННЫЕ API) ====================
// ... (остальной код склада остаётся без изменений)

// ==================== СТАРЫЕ СТРАНИЦЫ ====================
app.get('/cart.html', (req, res) => {
  res.sendFile(__dirname + '/public/cart.html');
});

app.get('/orders.html', (req, res) => {
  res.sendFile(__dirname + '/public/orders.html');
});

app.get('/checkout.html', (req, res) => {
  res.sendFile(__dirname + '/public/checkout.html');
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Сервер запущен на порту ${PORT}`);
});
