require('dotenv').config();
const express = require('express');
const { Pool } = require('pg');
const telegramBot = require('./telegram-bot');

const app = express();
app.use(express.json());
app.use(express.static('public'));

// ==================== CORS ====================
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Headers', 'Origin, X-Requested-With, Content-Type, Accept, Authorization');
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
  max: 10,
});

pool.connect((err, client, release) => {
  if (err) {
    console.error('❌ Ошибка подключения к базе данных:', err.message);
  } else {
    console.log('✅ Подключение к базе данных установлено');
    release();
  }
});

// ==================== ИНИЦИАЛИЗАЦИЯ TELEGRAM БОТА ====================
let BASE_URL = process.env.SITE_URL;

if (!BASE_URL) {
    if (process.env.RENDER_EXTERNAL_URL) {
        BASE_URL = process.env.RENDER_EXTERNAL_URL;
    } else if (process.env.RENDER_SITE_URL) {
        BASE_URL = process.env.RENDER_SITE_URL;
    } else {
        BASE_URL = 'https://dpsbor.ru';
    }
}

BASE_URL = BASE_URL.replace(/\/$/, '');

console.log(`🌐 Базовый URL для webhook: ${BASE_URL}`);

if (process.env.TELEGRAM_BOT_TOKEN) {
    telegramBot.initTelegramBot(process.env.TELEGRAM_BOT_TOKEN, BASE_URL);
} else {
    console.log('⚠️ TELEGRAM_BOT_TOKEN не задан, бот не будет работать');
}

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
             COALESCE(json_agg(json_build_object(
               'id', v.id,
               'name', v.name,
               'price', v.price,
               'weight_kg', v.weight_kg,
               'is_active', v.is_active
             ) ORDER BY v.sort_order) FILTER (WHERE v.id IS NOT NULL), '[]') as variants
      FROM products p
      LEFT JOIN variants v ON p.id = v.product_id AND v.is_active = true
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
    const result = await pool.query(
      'SELECT * FROM orders WHERE user_telegram_id = $1 ORDER BY id DESC',
      [userId]
    );
    const orders = result.rows.map(order => {
      if (order.items) order.items = typeof order.items === 'string' ? JSON.parse(order.items) : order.items;
      if (order.contact) order.contact = typeof order.contact === 'string' ? JSON.parse(order.contact) : order.contact;
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
      'SELECT district, address, sort_order, seller_id, prefix FROM pickup_locations ORDER BY district, sort_order'
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
  
  try {
    const data = req.body;
    
    if (!data) {
      return res.status(400).json({ error: 'No data' });
    }

    const userId = data.userId;
    const items = data.items;
    const total = data.total;
    const contact = data.contact;
    const request_id = data.requestId;

    if (!userId || !items || !total || !contact?.address) {
      return res.status(400).json({ error: 'Missing required fields' });
    }

    if (request_id) {
      const existing = await pool.query('SELECT id FROM orders WHERE request_id = $1', [request_id]);
      if (existing.rows.length > 0) {
        return res.status(409).json({ error: 'Duplicate order' });
      }
    }

    let seller_id = null;
    let prefix = null;
    
    if (contact.deliveryType === 'pickup') {
      const addrResult = await pool.query(
        'SELECT seller_id, prefix FROM pickup_locations WHERE address = $1', 
        [contact.address]
      );
      if (addrResult.rows.length === 0) {
        return res.status(400).json({ error: 'Invalid pickup address' });
      }
      seller_id = addrResult.rows[0].seller_id;
      prefix = addrResult.rows[0].prefix;
      
      if (!prefix) {
        const seller = await pool.query('SELECT name FROM users WHERE id = $1', [seller_id]);
        const seller_name = seller.rows[0]?.name || 'X';
        prefix = seller_name[0].toUpperCase();
      }
    } else {
      seller_id = 6;
      prefix = 'D';
    }

    let total_sum = 0;
    const orderItems = items.map(item => {
      const itemTotal = (item.priceAtTime || item.price) * item.quantity;
      total_sum += itemTotal;
      return {
        productId: item.productId,
        variantId: item.variantId,
        name: item.name,
        variantName: item.variantName,
        quantity: item.quantity,
        price: item.priceAtTime || item.price,
      };
    });

    const order_number = await generateOrderNumber(prefix);
    const itemsJson = JSON.stringify(orderItems);
    const contactJson = JSON.stringify(contact);

    const insertResult = await pool.query(`
      INSERT INTO orders (order_number, user_telegram_id, seller_id, items, total, contact, status, request_id, created_at)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, NOW())
      RETURNING id
    `, [order_number, userId, seller_id, itemsJson, total_sum, contactJson, 'new', request_id]);

    const orderId = insertResult.rows[0].id;

    await pool.query('DELETE FROM carts WHERE user_id = $1', [userId]);

    console.log(`✅ Заказ ${order_number} создан с ID: ${orderId}`);
    
    res.status(200).json({ orderNumber: order_number, id: orderId });

  } catch (err) {
    console.error('❌ Ошибка в /api/order:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ==================== TELEGRAM WEBHOOK ====================
app.post('/api/telegram/webhook', async (req, res) => {
    try {
        const update = req.body;
        
        if (update.message && update.message.text) {
            const messageData = await telegramBot.handleIncomingMessage(update.message);
            
            if (!messageData) {
                return res.sendStatus(200);
            }
            
            console.log(`🔍 Поиск заказа для telegram_id: ${messageData.senderId}`);
            
            let orderId = null;
            let userId = null;
            
            const orderResult = await pool.query(`
                SELECT id, user_telegram_id, order_number, status FROM orders 
                WHERE (contact->>'telegram_id' = $1 OR user_telegram_id = $2::bigint)
                  AND status IN ('new', 'processing')
                ORDER BY created_at DESC LIMIT 1
            `, [messageData.senderId, messageData.senderId]);
            
            if (orderResult.rows.length > 0) {
                orderId = orderResult.rows[0].id;
                userId = orderResult.rows[0].user_telegram_id;
                console.log(`✅ Найден активный заказ №${orderResult.rows[0].order_number} (статус: ${orderResult.rows[0].status})`);
            } else {
                console.log(`⚠️ Активный заказ для telegram_id ${messageData.senderId} не найден`);
            }
            
            const insertResult = await pool.query(`
                INSERT INTO chat_messages (
                    order_id, channel, external_id, 
                    sender_id, sender_name, message_text, 
                    direction, status, created_at
                )
                VALUES ($1, $2, $3, $4, $5, $6, 'incoming', 'delivered', NOW())
                RETURNING id
            `, [
                orderId,
                messageData.channel,
                messageData.externalId,
                messageData.senderId,
                messageData.senderName,
                messageData.messageText
            ]);
            
            console.log(`✅ Сообщение сохранено в БД (ID: ${insertResult.rows[0].id}) от ${messageData.senderName} (ID: ${messageData.senderId})`);
        }
        
        res.sendStatus(200);
    } catch (err) {
        console.error('❌ Ошибка в Telegram webhook:', err);
        res.sendStatus(500);
    }
});

// ==================== API ДЛЯ ОТПРАВКИ СООБЩЕНИЙ ====================
app.post('/api/chat/send', checkManagerAuth, async (req, res) => {
    const { order_id, channel, recipient_id, message_text } = req.body;
    
    console.log('📤 Отправка сообщения:', { order_id, channel, recipient_id, message_text: message_text?.substring(0, 50) });
    
    if (!recipient_id || !message_text) {
        return res.status(400).json({ error: 'Не указан получатель или текст сообщения' });
    }
    
    const recipientIdNum = parseInt(recipient_id);
    if (isNaN(recipientIdNum) || recipientIdNum < 100000) {
        console.error(`❌ Неверный recipient_id: ${recipient_id}`);
        return res.status(400).json({ error: 'Неверный формат получателя' });
    }
    
    try {
        const orderCheck = await pool.query('SELECT status FROM orders WHERE id = $1', [order_id]);
        if (orderCheck.rows.length > 0 && orderCheck.rows[0].status !== 'processing') {
            return res.status(403).json({ error: 'Чат доступен только для заказов в работе' });
        }
        
        let externalId = null;
        let sendSuccess = false;
        
        if (channel === 'telegram') {
            if (!telegramBot.isInitialized()) {
                return res.status(500).json({ error: 'Telegram бот не инициализирован' });
            }
            
            console.log(`📨 Отправка в Telegram получателю: ${recipientIdNum}`);
            const sent = await telegramBot.sendTelegramMessage(recipientIdNum, message_text);
            if (sent) {
                externalId = String(sent.message_id);
                sendSuccess = true;
                console.log(`✅ Сообщение отправлено, message_id: ${externalId}`);
            } else {
                return res.status(500).json({ error: 'Ошибка отправки сообщения в Telegram' });
            }
        } else {
            return res.status(400).json({ error: `Канал ${channel} пока не поддерживается` });
        }
        
        if (sendSuccess) {
            const result = await pool.query(`
                INSERT INTO chat_messages (
                    order_id, channel, external_id, 
                    sender_id, sender_name, message_text, 
                    direction, status, created_at
                )
                VALUES ($1, $2, $3, $4, $5, $6, 'outgoing', 'sent', NOW())
                RETURNING id
            `, [
                order_id,
                channel,
                externalId,
                String(req.userId),
                'Менеджер',
                message_text
            ]);
            
            console.log(`✅ Сообщение сохранено в БД, ID: ${result.rows[0].id}`);
            res.json({ success: true, messageId: result.rows[0].id });
        } else {
            res.status(500).json({ error: 'Не удалось отправить сообщение' });
        }
        
    } catch (err) {
        console.error('❌ Ошибка отправки сообщения:', err);
        res.status(500).json({ error: err.message });
    }
});

// ==================== ПОЛУЧЕНИЕ ЧАТА ПО ЗАКАЗУ ====================
app.get('/api/manager/order/:orderId/chat', checkManagerAuth, async (req, res) => {
    const { orderId } = req.params;
    
    try {
        const orderResult = await pool.query(`
            SELECT contact, user_telegram_id, order_number, status FROM orders WHERE id = $1
        `, [orderId]);
        
        if (orderResult.rows.length === 0) {
            return res.status(404).json({ error: 'Заказ не найден' });
        }
        
        const order = orderResult.rows[0];
        const contact = typeof order.contact === 'string' ? JSON.parse(order.contact) : order.contact || {};
        
        const messagesResult = await pool.query(`
            SELECT * FROM chat_messages 
            WHERE order_id = $1
            ORDER BY created_at ASC
        `, [orderId]);
        
        const oldOrdersResult = await pool.query(`
            SELECT order_number, status, created_at 
            FROM orders 
            WHERE user_telegram_id = $1 
              AND id != $2
            ORDER BY created_at DESC
        `, [order.user_telegram_id, orderId]);
        
        let recipientId = null;
        let recipientChannel = null;
        
        if (contact.telegram_id) {
            recipientId = contact.telegram_id;
            recipientChannel = 'telegram';
        } else if (order.user_telegram_id) {
            recipientId = String(order.user_telegram_id);
            recipientChannel = 'telegram';
        }
        
        console.log(`📱 Получатель для заказа ${order.order_number}: ${recipientId} (${recipientChannel})`);
        
        res.json({
            order_number: order.order_number,
            status: order.status,
            messages: messagesResult.rows,
            old_orders: oldOrdersResult.rows,
            recipient: {
                id: recipientId,
                channel: recipientChannel,
                name: contact.name || contact.telegram_name || 'Клиент'
            }
        });
    } catch (err) {
        console.error('❌ Ошибка получения чата:', err);
        res.status(500).json({ error: 'Database error' });
    }
});

// ==================== ПРОВЕРКА НЕПРОЧИТАННЫХ СООБЩЕНИЙ ====================
app.get('/api/manager/order/:orderId/unread', checkManagerAuth, async (req, res) => {
    const { orderId } = req.params;
    
    try {
        const result = await pool.query(`
            SELECT COUNT(*) > 0 as has_unread
            FROM chat_messages 
            WHERE order_id = $1 
              AND direction = 'incoming' 
              AND status != 'read'
        `, [orderId]);
        
        res.json({ hasUnread: result.rows[0].has_unread });
    } catch (err) {
        console.error('Ошибка проверки непрочитанных сообщений:', err);
        res.status(500).json({ error: 'Database error' });
    }
});

// ==================== ОТМЕТИТЬ СООБЩЕНИЯ КАК ПРОЧИТАННЫЕ ====================
app.post('/api/manager/chat/mark-read/:orderId', checkManagerAuth, async (req, res) => {
    const { orderId } = req.params;
    
    try {
        await pool.query(`
            UPDATE chat_messages 
            SET status = 'read' 
            WHERE order_id = $1 AND direction = 'incoming'
        `, [orderId]);
        
        res.json({ success: true });
    } catch (err) {
        console.error('Ошибка отметки сообщений как прочитанных:', err);
        res.status(500).json({ error: 'Database error' });
    }
});

// ==================== API ДЛЯ СПИСКА ЧАТОВ ====================
app.get('/api/manager/chats-list', checkManagerAuth, async (req, res) => {
    try {
        const activeResult = await pool.query(`
            SELECT DISTINCT 
                o.id as order_id,
                o.order_number,
                o.contact,
                o.user_telegram_id,
                o.status,
                (
                    SELECT message_text 
                    FROM chat_messages 
                    WHERE order_id = o.id
                    ORDER BY created_at DESC 
                    LIMIT 1
                ) as last_message,
                (
                    SELECT created_at 
                    FROM chat_messages 
                    WHERE order_id = o.id
                    ORDER BY created_at DESC 
                    LIMIT 1
                ) as last_message_date,
                (
                    SELECT direction 
                    FROM chat_messages 
                    WHERE order_id = o.id
                    ORDER BY created_at DESC 
                    LIMIT 1
                ) as last_message_direction
            FROM orders o
            WHERE o.status IN ('new', 'processing')
              AND EXISTS (SELECT 1 FROM chat_messages WHERE order_id = o.id)
            ORDER BY last_message_date DESC NULLS LAST
        `);
        
        const completedResult = await pool.query(`
            WITH last_completed_orders AS (
                SELECT DISTINCT ON (user_telegram_id) 
                    id,
                    order_number,
                    contact,
                    user_telegram_id,
                    status,
                    created_at
                FROM orders 
                WHERE status = 'completed'
                  AND user_telegram_id IS NOT NULL
                  AND EXISTS (SELECT 1 FROM chat_messages WHERE order_id = orders.id)
                ORDER BY user_telegram_id, created_at DESC
            )
            SELECT 
                lco.id as order_id,
                lco.order_number,
                lco.contact,
                lco.user_telegram_id,
                lco.status,
                (
                    SELECT message_text 
                    FROM chat_messages 
                    WHERE order_id = lco.id
                    ORDER BY created_at DESC 
                    LIMIT 1
                ) as last_message,
                (
                    SELECT created_at 
                    FROM chat_messages 
                    WHERE order_id = lco.id
                    ORDER BY created_at DESC 
                    LIMIT 1
                ) as last_message_date,
                (
                    SELECT direction 
                    FROM chat_messages 
                    WHERE order_id = lco.id
                    ORDER BY created_at DESC 
                    LIMIT 1
                ) as last_message_direction
            FROM last_completed_orders lco
            ORDER BY last_message_date DESC NULLS LAST
        `);
        
        const formatChat = (row) => {
            const contact = typeof row.contact === 'string' ? JSON.parse(row.contact) : row.contact || {};
            return {
                orderId: row.order_id,
                orderNumber: row.order_number,
                clientName: contact.name || contact.telegram_name || 'Клиент',
                lastMessage: row.last_message ? row.last_message.substring(0, 100) : null,
                lastMessageDate: row.last_message_date ? new Date(row.last_message_date).toLocaleString('ru-RU', {
                    hour: '2-digit',
                    minute: '2-digit',
                    day: '2-digit',
                    month: '2-digit'
                }) : null,
                lastMessageDirection: row.last_message_direction,
                status: row.status
            };
        };
        
        res.json({
            active: activeResult.rows.map(formatChat),
            completed: completedResult.rows.map(formatChat)
        });
    } catch (err) {
        console.error('Ошибка получения списка чатов:', err);
        res.status(500).json({ error: 'Database error' });
    }
});

// ==================== ПОЛУЧЕНИЕ ЗАКАЗА ПО НОМЕРУ ====================
app.get('/api/manager/order-by-number/:orderNumber', checkManagerAuth, async (req, res) => {
    const { orderNumber } = req.params;
    
    try {
        const result = await pool.query(`
            SELECT id FROM orders WHERE order_number = $1
        `, [orderNumber]);
        
        if (result.rows.length === 0) {
            return res.status(404).json({ error: 'Заказ не найден' });
        }
        
        res.json({ orderId: result.rows[0].id });
    } catch (err) {
        console.error('Ошибка поиска заказа по номеру:', err);
        res.status(500).json({ error: 'Database error' });
    }
});

// ==================== ИНФОРМАЦИЯ О СООБЩЕНИЯХ ДЛЯ ЗАКАЗА ====================
app.get('/api/manager/order/:orderId/messages-info', checkManagerAuth, async (req, res) => {
    const { orderId } = req.params;
    
    try {
        const messagesResult = await pool.query(`
            SELECT message_text, created_at, direction
            FROM chat_messages 
            WHERE order_id = $1
            ORDER BY created_at DESC
            LIMIT 1
        `, [orderId]);
        
        const hasMessages = messagesResult.rows.length > 0;
        const lastMessage = hasMessages ? messagesResult.rows[0].message_text : null;
        const lastMessageDate = hasMessages ? messagesResult.rows[0].created_at : null;
        
        res.json({
            hasMessages,
            lastMessage: lastMessage ? lastMessage.substring(0, 100) : null,
            lastMessageDate: lastMessageDate ? new Date(lastMessageDate).toLocaleString('ru-RU') : null
        });
    } catch (err) {
        console.error('Ошибка получения информации о сообщениях:', err);
        res.status(500).json({ error: 'Database error' });
    }
});

// ==================== ПАНЕЛЬ УПРАВЛЕНИЯ (MANAGER) ====================

const validTokens = new Map();

app.post('/api/manager/auth', async (req, res) => {
  const { telegram_id, name } = req.body;
  
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

app.get('/api/manager/me', checkManagerAuth, async (req, res) => {
  const result = await pool.query('SELECT id, name, role FROM users WHERE id = $1', [req.userId]);
  res.json(result.rows[0]);
});

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

app.get('/api/manager/orders', checkManagerAuth, async (req, res) => {
  try {
    const { status, page = 1, limit = 20 } = req.query;
    const offset = (page - 1) * limit;
    
    let query = `
      SELECT id, order_number, contact, items, total, status, seller_id, user_telegram_id, created_at, completed_at
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
    const orders = result.rows.map(order => {
      let contact = {};
      let items = [];
      try {
        contact = typeof order.contact === 'string' ? JSON.parse(order.contact) : order.contact || {};
        items = typeof order.items === 'string' ? JSON.parse(order.items) : order.items || [];
      } catch (e) {
        console.error('Ошибка парсинга JSON для заказа', order.id, e.message);
      }
      return {
        id: order.id,
        order_number: order.order_number,
        contact: contact,
        items: items,
        total: order.total,
        status: order.status,
        seller_id: order.seller_id,
        user_telegram_id: order.user_telegram_id,
        created_at: order.created_at,
        completed_at: order.completed_at
      };
    });
    
    res.json({ orders });
  } catch (err) {
    console.error('Orders error:', err);
    res.status(500).json({ error: 'Database error' });
  }
});

// ==================== ВЗЯТЬ ЗАКАЗ В РАБОТУ (С УВЕДОМЛЕНИЕМ) ====================
app.put('/api/manager/order/:id/take', checkManagerAuth, async (req, res) => {
  const { id } = req.params;
  try {
    const orderResult = await pool.query(`
      SELECT id, order_number, user_telegram_id, contact, status 
      FROM orders 
      WHERE id = $1 AND status = $2
    `, [id, 'new']);
    
    if (orderResult.rows.length === 0) {
      return res.status(404).json({ error: 'Заказ не найден или уже в работе' });
    }
    
    const order = orderResult.rows[0];
    const contact = typeof order.contact === 'string' ? JSON.parse(order.contact) : order.contact || {};
    
    let recipientId = null;
    if (contact.telegram_id) {
      recipientId = contact.telegram_id;
    } else if (order.user_telegram_id) {
      recipientId = String(order.user_telegram_id);
    }
    
    await pool.query('BEGIN');
    
    await pool.query(
      'UPDATE orders SET status = $1, seller_id = $2 WHERE id = $3',
      ['processing', req.userId, id]
    );
    
    await pool.query('COMMIT');
    
    // Отправляем уведомление
    if (recipientId && telegramBot.isInitialized()) {
      const message = `🟢 Ваш заказ №${order.order_number} принят в работу!\n\n` +
                     `Менеджер скоро свяжется с вами для уточнения деталей.\n\n` +
                     `Если у вас есть вопросы, напишите нам в чат на сайте: https://dpsbor.ru`;
      
      try {
        const sent = await telegramBot.sendTelegramMessage(recipientId, message);
        if (sent) {
          console.log(`✅ Уведомление о принятии заказа №${order.order_number} отправлено в Telegram`);
          
          await pool.query(`
            INSERT INTO chat_messages (
              order_id, channel, external_id, 
              sender_id, sender_name, message_text, 
              direction, status, created_at
            )
            VALUES ($1, $2, $3, $4, $5, $6, 'outgoing', 'sent', NOW())
          `, [
            id,
            'telegram',
            String(sent.message_id),
            'system',
            'Система',
            message,
          ]);
        }
      } catch (err) {
        console.error(`❌ Ошибка отправки уведомления о принятии заказа:`, err.message);
      }
    }
    
    res.json({ success: true });
  } catch (err) {
    await pool.query('ROLLBACK');
    console.error('Take order error:', err);
    res.status(500).json({ error: 'Database error' });
  }
});

// ==================== ЗАВЕРШЕНИЕ ЗАКАЗА (С УВЕДОМЛЕНИЕМ) ====================
app.put('/api/manager/order/:id/complete', checkManagerAuth, async (req, res) => {
  const { id } = req.params;
  try {
    const orderResult = await pool.query(`
      SELECT id, order_number, user_telegram_id, contact, status 
      FROM orders 
      WHERE id = $1 AND status = $2
    `, [id, 'processing']);
    
    if (orderResult.rows.length === 0) {
      return res.status(404).json({ error: 'Заказ не найден или не в работе' });
    }
    
    const order = orderResult.rows[0];
    const contact = typeof order.contact === 'string' ? JSON.parse(order.contact) : order.contact || {};
    
    let recipientId = null;
    if (contact.telegram_id) {
      recipientId = contact.telegram_id;
    } else if (order.user_telegram_id) {
      recipientId = String(order.user_telegram_id);
    }
    
    await pool.query(
      'UPDATE orders SET status = $1, completed_at = NOW() WHERE id = $2',
      ['completed', id]
    );
    
    // Отправляем уведомление о завершении
    if (recipientId && telegramBot.isInitialized()) {
      const message = `✅ Ваш заказ №${order.order_number} завершен!\n\n` +
                     `Спасибо, что выбрали ДП СБОР!\n\n` +
                     `📦 Для оформления нового заказа перейдите на сайт:\n` +
                     `https://dpsbor.ru\n\n` +
                     `Будем рады видеть вас снова! 🌰🍎`;
      
      try {
        const sent = await telegramBot.sendTelegramMessage(recipientId, message);
        if (sent) {
          console.log(`✅ Уведомление о завершении заказа №${order.order_number} отправлено в Telegram (${recipientId})`);
          
          await pool.query(`
            INSERT INTO chat_messages (
              order_id, channel, external_id, 
              sender_id, sender_name, message_text, 
              direction, status, created_at
            )
            VALUES ($1, $2, $3, $4, $5, $6, 'outgoing', 'sent', NOW())
          `, [
            id,
            'telegram',
            String(sent.message_id),
            'system',
            'Система',
            message,
          ]);
        }
      } catch (err) {
        console.error(`❌ Ошибка отправки уведомления о завершении заказа:`, err.message);
      }
    } else {
      console.log(`⚠️ Не удалось отправить уведомление: recipientId=${recipientId}, bot=${telegramBot.isInitialized()}`);
    }
    
    res.json({ success: true });
  } catch (err) {
    console.error('Complete order error:', err);
    res.status(500).json({ error: 'Database error' });
  }
});

app.get('/api/manager/order/:id', checkManagerAuth, async (req, res) => {
  const { id } = req.params;
  try {
    const result = await pool.query('SELECT * FROM orders WHERE id = $1', [id]);
    if (result.rows.length === 0) return res.status(404).json({ error: 'Order not found' });
    
    const order = result.rows[0];
    try {
      order.items = typeof order.items === 'string' ? JSON.parse(order.items) : order.items || [];
      order.contact = typeof order.contact === 'string' ? JSON.parse(order.contact) : order.contact || {};
    } catch (e) {
      console.error('Ошибка парсинга JSON:', e.message);
    }
    
    res.json({ order });
  } catch (err) {
    console.error('Get order error:', err);
    res.status(500).json({ error: 'Database error' });
  }
});

// ==================== СКЛАД (РАСШИРЕННЫЕ API) ====================
// ... (весь код склада остается без изменений) ...

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`🚀 Сервер запущен на порту ${PORT}`);
});
