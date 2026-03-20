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

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});

// ==================== ГЛАВНАЯ СТРАНИЦА ====================
app.get('/', (req, res) => {
  res.sendFile(__dirname + '/public/website/index.html');
});

// ==================== API ТОВАРОВ И КОРЗИНЫ ====================

// Получение всех товаров
app.get('/api/products', async (req, res) => {
  try {
    const products = await pool.query(`
      SELECT id, name, description, image, category 
      FROM products 
      ORDER BY id
    `);
    
    const variants = await pool.query(`
      SELECT 
        v.id, 
        v.product_id, 
        v.name, 
        v.price, 
        v.weight_kg, 
        v.packaging_cost,
        v.sort_order,
        v.is_active,
        p.purchase_price_kg
      FROM product_variants v
      JOIN products p ON v.product_id = p.id
      ORDER BY v.product_id, v.sort_order
    `);
    
    const variantsByProduct = {};
    variants.rows.forEach(v => {
      if (!variantsByProduct[v.product_id]) {
        variantsByProduct[v.product_id] = [];
      }
      
      const base_cost = (v.purchase_price_kg * v.weight_kg) + (v.packaging_cost || 0);
      const avg_price = (v.price + base_cost) / 2;
      const price_seller = Math.ceil(avg_price / 10) * 10;
      
      variantsByProduct[v.product_id].push({
        id: v.id,
        name: v.name,
        price: v.price,
        price_seller: price_seller,
        weight_kg: v.weight_kg,
        packaging_cost: v.packaging_cost,
        sort_order: v.sort_order,
        is_active: v.is_active
      });
    });

    const result = products.rows.map(p => ({
      id: p.id,
      name: p.name,
      description: p.description,
      image: p.image,
      category: p.category,
      variants: variantsByProduct[p.id] || []
    }));
    
    res.json(result);
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
        p.name, p.description, p.image,
        v.name as variant_name, v.price
      FROM carts c
      JOIN products p ON c.product_id = p.id
      LEFT JOIN product_variants v ON c.variant_id = v.id
      WHERE c.user_id = $1
    `, [userId]);

    const items = result.rows.map(row => ({
      productId: row.product_id,
      variantId: row.variant_id,
      quantity: row.quantity,
      priceAtTime: row.price_at_time,
      name: row.name,
      variantName: row.variant_name,
      price: row.price,
      description: row.description,
      image: row.image
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
      'SELECT price, is_active FROM product_variants WHERE id = $1 AND product_id = $2',
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

// Получение заказов пользователя
app.get('/api/orders/:userId', async (req, res) => {
  const userId = parseInt(req.params.userId, 10);
  try {
    const result = await pool.query('SELECT * FROM orders WHERE user_id = $1 ORDER BY id DESC', [userId]);
    
    // Парсим JSON-поля
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

// Обновление статуса заказа (для админ-панели, если будет)
app.put('/api/order/:orderId', async (req, res) => {
  const orderId = parseInt(req.params.orderId, 10);
  const { status } = req.body;

  const allowed = ['Активный', 'Завершен', 'Отменен'];
  if (!allowed.includes(status)) {
    return res.status(400).json({ error: 'Invalid status' });
  }

  try {
    await pool.query('UPDATE orders SET status = $1 WHERE id = $2', [status, orderId]);
    res.json({ success: true });
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

// Вспомогательная функция для генерации номера заказа
async function generateOrderNumber(prefix) {
  if (!prefix) {
    console.error('generateOrderNumber: prefix is null, using X');
    prefix = 'X';
  }
  
  if (prefix.length > 3) {
    prefix = prefix.substring(0, 3);
  }
  
  try {
    const result = await pool.query(
      `SELECT order_number FROM orders 
       WHERE order_number LIKE $1 
       ORDER BY id DESC LIMIT 1`,
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

    if (!userId || !items || !total || !contact?.address) {
      console.error('❌ Отсутствуют обязательные поля');
      return res.status(400).json({ error: 'Missing required fields' });
    }

    // Проверка на дубликат
    if (request_id) {
      console.log(`🔍 Проверка request_id: ${request_id}`);
      const existing = await pool.query('SELECT id FROM orders WHERE request_id = $1', [request_id]);
      if (existing.rows.length > 0) {
        console.log(`⚠️ Дублирующийся запрос с requestId ${request_id} отклонён`);
        return res.status(409).json({ error: 'Duplicate order' });
      }
      console.log('✅ Request_id уникален');
    }

    // Получаем seller_id из точки самовывоза
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
        const seller = await pool.query('SELECT name FROM sellers WHERE id = $1', [seller_id]);
        const seller_name = seller.rows[0]?.name || 'X';
        prefix = seller_name[0].toUpperCase();
        console.log(`⚠️ Префикс не задан, использовано имя продавца: ${prefix}`);
      }
    } else {
      seller_id = 6;
      prefix = 'D';
      console.log(`🚚 Доставка: продавец-админ ID=6, префикс=D`);
    }

    console.log(`✅ Определён продавец ID: ${seller_id}, префикс: ${prefix}`);

    // Получаем содержимое корзины
    console.log(`🔍 Получение корзины пользователя ${userId}`);
    const cartResult = await pool.query(`
      SELECT 
        c.product_id, c.variant_id, c.quantity, c.price_at_time,
        p.name,
        v.name as variant_name
      FROM carts c
      JOIN products p ON c.product_id = p.id
      LEFT JOIN product_variants v ON c.variant_id = v.id
      WHERE c.user_id = $1
    `, [userId]);

    console.log(`📦 Найдено позиций в корзине: ${cartResult.rows.length}`);

    if (cartResult.rows.length === 0) {
      console.error('❌ Корзина пуста');
      return res.status(400).json({ error: 'Cart is empty' });
    }

    let total_sum = 0;
    const orderItems = cartResult.rows.map(row => {
      const itemTotal = row.price_at_time * row.quantity;
      total_sum += itemTotal;
      return {
        productId: row.product_id,
        variantId: row.variant_id,
        name: row.name,
        variantName: row.variant_name,
        quantity: row.quantity,
        price: row.price_at_time,
      };
    });

    console.log('📝 Состав заказа:', orderItems);
    console.log(`💰 Итого: ${total_sum}`);

    // Генерируем номер заказа
    console.log(`🔢 Генерация номера для префикса: ${prefix}`);
    const order_number = await generateOrderNumber(prefix);
    console.log(`✅ Сгенерирован номер заказа: ${order_number}`);

    const itemsJson = JSON.stringify(orderItems);
    const contactJson = JSON.stringify(contact);

    // Сохраняем заказ в БД
    console.log('💾 Сохранение заказа в БД...');
    const insertResult = await pool.query(`
      INSERT INTO orders (order_number, user_id, seller_id, address_id, items, total, contact, status, request_id)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
      RETURNING id
    `, [order_number, userId, seller_id, address_id, itemsJson, total_sum, contactJson, 'Активный', request_id]);

    const orderId = insertResult.rows[0].id;
    console.log(`✅ Заказ сохранён с ID: ${orderId}`);

    // Очищаем корзину
    await pool.query('DELETE FROM carts WHERE user_id = $1', [userId]);
    console.log('✅ Корзина очищена');

    console.log('='.repeat(60));
    console.log('✅ ЗАКАЗ УСПЕШНО ОБРАБОТАН');
    console.log('='.repeat(60));
    
    // Возвращаем только номер заказа — НИКАКИХ ВЫЗОВОВ YOUGILE
    res.status(200).json({ 
      orderNumber: order_number 
    });

  } catch (err) {
    console.error('❌ КРИТИЧЕСКАЯ ОШИБКА В /api/order:');
    console.error(err);
    console.error('='.repeat(60));
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ==================== СТАРЫЕ СТРАНИЦЫ (для совместимости) ====================
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
