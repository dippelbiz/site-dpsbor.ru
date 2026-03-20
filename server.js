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
});

// ==================== ВСПОМОГАТЕЛЬНЫЕ ФУНКЦИИ ====================
function normalizeNumber(value) {
  if (value === undefined || value === null || value === '') return null;
  let str = String(value).trim();
  str = str.replace(',', '.');
  const parts = str.split('.');
  if (parts.length > 2) {
    str = parts[0] + '.' + parts.slice(1).join('');
  }
  const num = parseFloat(str);
  return isNaN(num) ? null : num;
}

function getDateFilter(period) {
  switch (period) {
    case 'today':
      return `DATE(created_at) = CURRENT_DATE`;
    case 'week':
      return `created_at >= NOW() - INTERVAL '7 days'`;
    case 'month':
      return `created_at >= NOW() - INTERVAL '30 days'`;
    default:
      return `1=1`;
  }
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
    if (variant.rows.length === 0) {
      return res.status(400).json({ error: 'Invalid variant' });
    }
    if (!variant.rows[0].is_active) {
      return res.status(400).json({ error: 'Variant is not active' });
    }
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

app.get('/api/orders/:userId', async (req, res) => {
  const userId = parseInt(req.params.userId, 10);
  try {
    const result = await pool.query('SELECT * FROM orders WHERE user_id = $1 ORDER BY id DESC', [userId]);
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
    let address_id = null;
    let prefix = null;
    
    if (contact.deliveryType === 'pickup') {
      console.log(`🔍 Поиск точки самовывоза: ${contact.address}`);
      const addrResult = await pool.query(
        'SELECT id, seller_id, prefix FROM pickup_locations WHERE address = $1', 
        [contact.address]
      );
      if (addrResult.rows.length === 0) {
        console.error(`❌ Адрес не найден: ${contact.address}`);
        return res.status(400).json({ error: 'Invalid pickup address' });
      }
      address_id = addrResult.rows[0].id;
      seller_id = addrResult.rows[0].seller_id;
      prefix = addrResult.rows[0].prefix;
      
      console.log(`✅ Точка найдена: ID=${address_id}, продавец=${seller_id}, префикс=${prefix}`);
      
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
      INSERT INTO orders (order_number, user_id, seller_id, address_id, items, total, contact, status, request_id)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
      RETURNING id
    `, [order_number, userId, seller_id, address_id, itemsJson, total_sum, contactJson, 'new', request_id]);

    const orderId = insertResult.rows[0].id;
    console.log(`✅ Заказ сохранён с ID: ${orderId}`);

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
    
    console.log('Query result:', result.rows);
    
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
    const { period = 'today' } = req.query;
    const dateFilter = getDateFilter(period);
    
    const userResult = await pool.query('SELECT name, role FROM users WHERE id = $1', [req.userId]);
    if (userResult.rows.length === 0) {
      return res.status(404).json({ error: 'User not found' });
    }
    const user = userResult.rows[0];
    
    let statsQuery;
    let statsParams = [];
    
    if (user.role === 'admin') {
      statsQuery = `
        SELECT 
          COUNT(CASE WHEN status = 'new' AND ${dateFilter} THEN 1 END) as new_orders,
          COUNT(CASE WHEN status = 'processing' AND ${dateFilter} THEN 1 END) as processing_orders,
          COUNT(CASE WHEN status = 'completed' AND ${dateFilter} THEN 1 END) as completed_count,
          COALESCE(SUM(CASE WHEN status = 'completed' AND ${dateFilter} THEN total END), 0) as revenue
        FROM orders
      `;
    } else {
      statsQuery = `
        SELECT 
          COUNT(CASE WHEN status = 'new' AND ${dateFilter} THEN 1 END) as new_orders,
          COUNT(CASE WHEN status = 'processing' AND ${dateFilter} THEN 1 END) as processing_orders,
          COUNT(CASE WHEN status = 'completed' AND ${dateFilter} THEN 1 END) as completed_count,
          COALESCE(SUM(CASE WHEN status = 'completed' AND ${dateFilter} THEN total END), 0) as revenue
        FROM orders
        WHERE seller_id = $1
      `;
      statsParams = [req.userId];
    }
    
    const statsResult = await pool.query(statsQuery, statsParams);
    const stats = statsResult.rows[0];
    
    let ordersQuery;
    let ordersParams = [];
    if (user.role === 'admin') {
      ordersQuery = `
        SELECT id, order_number, contact, total, status, created_at
        FROM orders
        ORDER BY created_at DESC
        LIMIT 10
      `;
    } else {
      ordersQuery = `
        SELECT id, order_number, contact, total, status, created_at
        FROM orders
        WHERE seller_id = $1
        ORDER BY created_at DESC
        LIMIT 10
      `;
      ordersParams = [req.userId];
    }
    
    const ordersResult = await pool.query(ordersQuery, ordersParams);
    const recentOrders = ordersResult.rows.map(order => ({
      ...order,
      contact: typeof order.contact === 'string' ? JSON.parse(order.contact) : order.contact
    }));
    
    res.json({
      user: { name: user.name, role: user.role },
      stats: {
        new_orders: parseInt(stats.new_orders) || 0,
        processing_orders: parseInt(stats.processing_orders) || 0,
        completed_count: parseInt(stats.completed_count) || 0,
        revenue: parseInt(stats.revenue) || 0
      },
      recent_orders: recentOrders
    });
  } catch (err) {
    console.error('Dashboard error:', err);
    res.status(500).json({ error: 'Database error' });
  }
});

app.get('/api/manager/orders', checkManagerAuth, async (req, res) => {
  try {
    const { status, page = 1, limit = 20 } = req.query;
    const offset = (page - 1) * limit;
    
    let query = `SELECT id, order_number, contact, total, status, created_at, completed_at FROM orders`;
    const params = [];
    
    if (status) {
      query += ` WHERE status = $${params.length + 1}`;
      params.push(status);
    }
    
    query += ` ORDER BY created_at DESC LIMIT $${params.length + 1} OFFSET $${params.length + 2}`;
    params.push(limit, offset);
    
    const result = await pool.query(query, params);
    const orders = result.rows.map(order => ({
      ...order,
      contact: typeof order.contact === 'string' ? JSON.parse(order.contact) : order.contact
    }));
    
    res.json({ orders });
  } catch (err) {
    console.error('Orders error:', err);
    res.status(500).json({ error: 'Database error' });
  }
});

app.put('/api/manager/order/:id', checkManagerAuth, async (req, res) => {
  const { id } = req.params;
  const { status } = req.body;
  
  const allowedStatuses = ['new', 'confirmed', 'processing', 'shipped', 'completed', 'cancelled'];
  if (!allowedStatuses.includes(status)) {
    return res.status(400).json({ error: 'Invalid status' });
  }
  
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

// ==================== СКЛАД (РАСШИРЕННЫЕ API) ====================

app.get('/api/manager/warehouse', checkManagerAuth, async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT 
        mw.id,
        v.id as variant_id,
        v.name as variant_name,
        p.name as product_name,
        mw.quantity,
        mw.reserved,
        (mw.quantity - mw.reserved) as available
      FROM main_warehouse mw
      JOIN variants v ON mw.variant_id = v.id
      JOIN products p ON v.product_id = p.id
      ORDER BY p.name, v.name
    `);
    res.json({ warehouse: result.rows });
  } catch (err) {
    console.error('Warehouse error:', err);
    res.status(500).json({ error: 'Database error' });
  }
});

app.post('/api/manager/warehouse/update', checkManagerAuth, async (req, res) => {
  const { variant_id, quantity, type, comment } = req.body;
  
  if (!variant_id || !quantity || !['income', 'outcome'].includes(type)) {
    return res.status(400).json({ error: 'Invalid data' });
  }
  
  try {
    await pool.query('BEGIN');
    
    if (type === 'income') {
      await pool.query(
        'UPDATE main_warehouse SET quantity = quantity + $1, last_updated = NOW() WHERE variant_id = $2',
        [quantity, variant_id]
      );
    } else {
      const checkResult = await pool.query('SELECT quantity FROM main_warehouse WHERE variant_id = $1', [variant_id]);
      if (checkResult.rows[0]?.quantity < quantity) {
        await pool.query('ROLLBACK');
        return res.status(400).json({ error: 'Недостаточно товара на складе' });
      }
      await pool.query(
        'UPDATE main_warehouse SET quantity = quantity - $1, last_updated = NOW() WHERE variant_id = $2',
        [quantity, variant_id]
      );
    }
    
    await pool.query(`
      INSERT INTO warehouse_operations (variant_id, source_type, type, quantity, user_id, comment)
      VALUES ($1, 'main', $2, $3, $4, $5)
    `, [variant_id, type, quantity, req.userId, comment]);
    
    await pool.query('COMMIT');
    res.json({ success: true });
  } catch (err) {
    await pool.query('ROLLBACK');
    console.error('Warehouse update error:', err);
    res.status(500).json({ error: 'Database error' });
  }
});

app.get('/api/manager/products', checkManagerAuth, async (req, res) => {
  const result = await pool.query('SELECT id, name FROM products ORDER BY name');
  res.json({ products: result.rows });
});

app.get('/api/manager/variants/:productId', checkManagerAuth, async (req, res) => {
  const { productId } = req.params;
  const result = await pool.query(
    'SELECT id, name, weight_kg, price FROM variants WHERE product_id = $1 AND is_active = true ORDER BY weight_kg',
    [productId]
  );
  res.json({ variants: result.rows });
});

app.post('/api/manager/warehouse/purchase', checkManagerAuth, async (req, res) => {
  let { product_id, quantity_kg, comment } = req.body;
  quantity_kg = normalizeNumber(quantity_kg);
  
  if (!product_id || !quantity_kg || quantity_kg <= 0) {
    return res.status(400).json({ error: 'Укажите корректное количество (например, 1.5 или 1,5)' });
  }
  
  try {
    await pool.query('BEGIN');
    
    const product = await pool.query('SELECT name FROM products WHERE id = $1', [product_id]);
    const productName = product.rows[0]?.name;
    
    if (!productName) {
      await pool.query('ROLLBACK');
      return res.status(404).json({ error: 'Товар не найден' });
    }
    
    const result = await pool.query(`
      INSERT INTO hub_stock (product_id, product_name, quantity_kg, updated_at)
      VALUES ($1, $2, $3, NOW())
      ON CONFLICT (product_id) DO UPDATE SET 
        quantity_kg = hub_stock.quantity_kg + EXCLUDED.quantity_kg,
        product_name = EXCLUDED.product_name,
        updated_at = NOW()
      RETURNING quantity_kg
    `, [product_id, productName, quantity_kg]);
    
    console.log(`✅ Закуплено ${quantity_kg} кг товара ${productName}. Новый остаток: ${result.rows[0].quantity_kg} кг`);
    
    await pool.query(`
      INSERT INTO warehouse_operations (variant_id, source_type, type, quantity, user_id, comment)
      VALUES (NULL, 'hub', 'purchase', $1, $2, $3)
    `, [quantity_kg, req.userId, comment || `Закупка ${productName}`]);
    
    await pool.query('COMMIT');
    res.json({ success: true, new_quantity: result.rows[0].quantity_kg });
  } catch (err) {
    await pool.query('ROLLBACK');
    console.error('Purchase error:', err);
    res.status(500).json({ error: 'Ошибка при закупке' });
  }
});

app.post('/api/manager/warehouse/packaging', checkManagerAuth, async (req, res) => {
  let { product_id, variant_id, quantity_kg, pieces } = req.body;
  quantity_kg = normalizeNumber(quantity_kg);
  pieces = normalizeNumber(pieces);
  
  if (!product_id || !variant_id || !quantity_kg || quantity_kg <= 0) {
    return res.status(400).json({ error: 'Укажите корректное количество' });
  }
  
  if (!pieces || pieces <= 0) {
    return res.status(400).json({ error: 'Укажите количество упаковок' });
  }
  
  try {
    await pool.query('BEGIN');
    
    const hubStock = await pool.query('SELECT quantity_kg FROM hub_stock WHERE product_id = $1', [product_id]);
    const available = hubStock.rows[0]?.quantity_kg || 0;
    if (available < quantity_kg) {
      await pool.query('ROLLBACK');
      return res.status(400).json({ error: `Недостаточно товара на хабе. Доступно: ${available} кг, требуется: ${quantity_kg} кг` });
    }
    
    await pool.query('UPDATE hub_stock SET quantity_kg = quantity_kg - $1, updated_at = NOW() WHERE product_id = $2', [quantity_kg, product_id]);
    
    await pool.query(`
      INSERT INTO main_warehouse (variant_id, quantity, reserved, last_updated)
      VALUES ($1, $2, 0, NOW())
      ON CONFLICT (variant_id) DO UPDATE SET 
        quantity = main_warehouse.quantity + EXCLUDED.quantity,
        last_updated = NOW()
    `, [variant_id, pieces]);
    
    await pool.query(`
      INSERT INTO warehouse_operations (variant_id, source_type, type, quantity, user_id, comment)
      VALUES ($1, 'hub', 'packaging', $2, $3, $4)
    `, [variant_id, pieces, req.userId, `Фасовка из ${quantity_kg} кг`]);
    
    await pool.query('COMMIT');
    res.json({ success: true });
  } catch (err) {
    await pool.query('ROLLBACK');
    console.error('Packaging error:', err);
    res.status(500).json({ error: 'Ошибка при фасовке' });
  }
});

// Получение списка продавцов (без кладовщиков для отображения в модалке)
app.get('/api/manager/sellers', checkManagerAuth, async (req, res) => {
  const result = await pool.query(
    "SELECT id, name, role FROM users WHERE role IN ('seller', 'admin') ORDER BY name"
  );
  res.json({ sellers: result.rows });
});

app.get('/api/manager/seller-stock/:sellerId', checkManagerAuth, async (req, res) => {
  const { sellerId } = req.params;
  const result = await pool.query(`
    SELECT p.name as product_name, v.name as variant_name, ss.quantity
    FROM seller_stock ss
    JOIN variants v ON ss.variant_id = v.id
    JOIN products p ON v.product_id = p.id
    WHERE ss.seller_id = $1 AND ss.quantity > 0
    ORDER BY p.name, v.name
  `, [sellerId]);
  res.json({ stock: result.rows });
});

app.get('/api/manager/hub-stock', checkManagerAuth, async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT product_name, quantity_kg 
      FROM hub_stock 
      WHERE quantity_kg > 0
      ORDER BY product_name
    `);
    res.json({ stock: result.rows });
  } catch (err) {
    console.error('Hub stock error:', err);
    res.status(500).json({ error: 'Database error' });
  }
});

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
