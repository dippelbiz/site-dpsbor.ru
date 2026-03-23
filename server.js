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

    console.log('📋 Получен contact:', JSON.stringify(contact, null, 2));

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

    // ✅ Определяем user_telegram_id только из contact.telegram_id, игнорируем userId=1
    let userTelegramId = null;
    if (contact.telegram_id && !isNaN(parseInt(contact.telegram_id)) && parseInt(contact.telegram_id) > 0) {
      userTelegramId = parseInt(contact.telegram_id);
    }

    console.log(`👤 Сохраняем user_telegram_id: ${userTelegramId}`);

    const insertResult = await pool.query(`
      INSERT INTO orders (order_number, user_telegram_id, seller_id, items, total, contact, status, request_id, created_at)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, NOW())
      RETURNING id
    `, [order_number, userTelegramId, seller_id, itemsJson, total_sum, contactJson, 'new', request_id]);

    const orderId = insertResult.rows[0].id;

    await pool.query('DELETE FROM carts WHERE user_id = $1', [userId]);

    console.log(`✅ Заказ ${order_number} создан с ID: ${orderId}, user_telegram_id: ${userTelegramId}`);
    
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
    if (isNaN(recipientIdNum) || recipientIdNum < 100000000) {
        console.error(`❌ Неверный recipient_id: ${recipient_id} (должен быть telegram_id)`);
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
            console.log(`📱 Найден telegram_id в contact: ${recipientId}`);
        } else if (order.user_telegram_id) {
            recipientId = String(order.user_telegram_id);
            recipientChannel = 'telegram';
            console.log(`📱 Используем user_telegram_id: ${recipientId}`);
        } else {
            console.log(`⚠️ Нет telegram_id для заказа ${order.order_number}`);
        }
        
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
    if (recipientId && telegramBot.isInitialized() && recipientId !== '1') {
      const message = `🟢 Ваш заказ №${order.order_number} принят в работу!\n\n` +
                     `Менеджер скоро свяжется с вами для уточнения деталей.\n\n`;
      
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
    } else {
      console.log(`⚠️ Не удалось отправить уведомление: recipientId=${recipientId}, bot=${telegramBot.isInitialized()}`);
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
    if (recipientId && telegramBot.isInitialized() && recipientId !== '1') {
      const message = `✅ Ваш заказ №${order.order_number} завершен!\n\n` +
                     `Спасибо, что выбрали DP SBOR!\n\n` +
                     `Для оформления нового заказа перейдите на сайт:\n` +
                     `https://dpsbor.ru\n\n` +
                     `Будем рады видеть вас снова!`;
      
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

app.get('/api/manager/warehouse', checkManagerAuth, async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT 
        mw.id,
        v.id as variant_id,
        v.name as variant_name,
        p.name as product_name,
        mw.quantity,
        COALESCE(mw.reserved, 0) as reserved,
        (mw.quantity - COALESCE(mw.reserved, 0)) as available
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

app.get('/api/manager/seller-stock/:sellerId', checkManagerAuth, async (req, res) => {
  const { sellerId } = req.params;
  
  const result = await pool.query(`
    WITH all_variants AS (
      SELECT 
        v.id as variant_id,
        v.name as variant_name,
        p.id as product_id,
        p.name as product_name,
        p.category
      FROM variants v
      JOIN products p ON v.product_id = p.id
      WHERE v.is_active = true
    ),
    seller_quantities AS (
      SELECT 
        ss.variant_id,
        ss.quantity,
        COALESCE(pt.pending_quantity, 0) as pending_quantity
      FROM seller_stock ss
      LEFT JOIN (
        SELECT variant_id, SUM(quantity) as pending_quantity
        FROM pending_transfers
        WHERE seller_id = $1 AND status = 'pending'
        GROUP BY variant_id
      ) pt ON ss.variant_id = pt.variant_id
      WHERE ss.seller_id = $1
    )
    SELECT 
      av.variant_id,
      av.variant_name,
      av.product_id,
      av.product_name,
      av.category,
      COALESCE(sq.quantity, 0) as quantity,
      COALESCE(sq.pending_quantity, 0) as pending_quantity
    FROM all_variants av
    LEFT JOIN seller_quantities sq ON av.variant_id = sq.variant_id
    ORDER BY av.category, av.product_name, av.variant_name
  `, [sellerId]);
  
  res.json({ stock: result.rows });
});

app.get('/api/manager/hub-stock', checkManagerAuth, async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT product_id, product_name, quantity_kg 
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

app.get('/api/manager/hub-stock/:productId', checkManagerAuth, async (req, res) => {
  const { productId } = req.params;
  try {
    const result = await pool.query(`
      SELECT quantity_kg, product_name 
      FROM hub_stock 
      WHERE product_id = $1
    `, [productId]);
    
    const available = result.rows[0]?.quantity_kg || 0;
    res.json({ 
      available: available,
      product_name: result.rows[0]?.product_name
    });
  } catch (err) {
    console.error('Hub stock check error:', err);
    res.status(500).json({ error: 'Database error' });
  }
});

app.get('/api/manager/warehouse-available/:variantId', checkManagerAuth, async (req, res) => {
  const { variantId } = req.params;
  try {
    const result = await pool.query(`
      SELECT quantity, COALESCE(reserved, 0) as reserved
      FROM main_warehouse 
      WHERE variant_id = $1
    `, [variantId]);
    
    const quantity = result.rows[0]?.quantity || 0;
    const reserved = result.rows[0]?.reserved || 0;
    const available = quantity - reserved;
    
    res.json({ 
      quantity: quantity,
      reserved: reserved,
      available: available
    });
  } catch (err) {
    console.error('Warehouse check error:', err);
    res.status(500).json({ error: 'Database error' });
  }
});

app.post('/api/manager/warehouse/purchase', checkManagerAuth, async (req, res) => {
  let { product_id, quantity_kg, comment } = req.body;
  quantity_kg = normalizeNumber(quantity_kg);
  
  if (!product_id || !quantity_kg || quantity_kg <= 0) {
    return res.status(400).json({ error: 'Укажите корректное количество (например, 1.5 или 1,5)' });
  }
  
  try {
    const product = await pool.query('SELECT name FROM products WHERE id = $1', [product_id]);
    const productName = product.rows[0]?.name;
    if (!productName) {
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
    
    await pool.query(`
      INSERT INTO warehouse_operations (variant_id, source_type, type, quantity, user_id, comment)
      VALUES (NULL, 'hub', 'purchase', $1, $2, $3)
    `, [quantity_kg, req.userId, comment || `Закупка ${productName}`]);
    
    res.json({ success: true, new_quantity: result.rows[0].quantity_kg });
  } catch (err) {
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
      return res.status(400).json({ 
        error: `Недостаточно товара для фасовки! Доступно: ${available} кг, требуется: ${quantity_kg} кг`,
        available: available,
        required: quantity_kg
      });
    }
    
    const variantInfo = await pool.query(`
      SELECT v.name, v.weight_kg, p.name as product_name
      FROM variants v
      JOIN products p ON v.product_id = p.id
      WHERE v.id = $1
    `, [variant_id]);
    
    if (variantInfo.rows.length === 0) {
      await pool.query('ROLLBACK');
      return res.status(400).json({ error: 'Вариант товара не найден' });
    }
    
    const variant = variantInfo.rows[0];
    const expectedKg = pieces * variant.weight_kg;
    
    if (Math.abs(expectedKg - quantity_kg) > 0.01) {
      await pool.query('ROLLBACK');
      return res.status(400).json({ 
        error: `Несоответствие веса! ${pieces} упаковок по ${variant.weight_kg} кг = ${expectedKg} кг, а указано ${quantity_kg} кг`
      });
    }
    
    await pool.query(`
      UPDATE hub_stock 
      SET quantity_kg = quantity_kg - $1, updated_at = NOW() 
      WHERE product_id = $2
    `, [quantity_kg, product_id]);
    
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
    `, [
      variant_id, 
      pieces, 
      req.userId, 
      `Фасовка: ${pieces} уп. (${variant.name}) из ${quantity_kg} кг ${variant.product_name}`
    ]);
    
    await pool.query('COMMIT');
    
    res.json({ 
      success: true, 
      message: `Расфасовано ${pieces} упаковок ${variant.name} (${quantity_kg} кг)`,
      new_hub_quantity: available - quantity_kg
    });
    
  } catch (err) {
    await pool.query('ROLLBACK');
    console.error('Packaging error:', err);
    res.status(500).json({ error: 'Ошибка при фасовке' });
  }
});

app.post('/api/manager/transfer-request', checkManagerAuth, async (req, res) => {
  const { variant_id, quantity } = req.body;
  
  if (!variant_id || !quantity || quantity <= 0) {
    return res.status(400).json({ error: 'Укажите корректное количество' });
  }
  
  try {
    await pool.query('BEGIN');
    
    const variantInfo = await pool.query(`
      SELECT v.name, v.weight_kg, p.name as product_name
      FROM variants v
      JOIN products p ON v.product_id = p.id
      WHERE v.id = $1
    `, [variant_id]);
    
    if (variantInfo.rows.length === 0) {
      await pool.query('ROLLBACK');
      return res.status(400).json({ error: 'Вариант товара не найден' });
    }
    
    const warehouseCheck = await pool.query(`
      SELECT quantity, COALESCE(reserved, 0) as reserved
      FROM main_warehouse 
      WHERE variant_id = $1
    `, [variant_id]);
    
    const currentQuantity = warehouseCheck.rows[0]?.quantity || 0;
    const currentReserved = warehouseCheck.rows[0]?.reserved || 0;
    const available = currentQuantity - currentReserved;
    
    if (available < quantity) {
      await pool.query('ROLLBACK');
      return res.status(400).json({ 
        error: `Недостаточно товара на главном складе!`,
        available: available,
        required: quantity,
        total: currentQuantity,
        reserved: currentReserved,
        variant_name: variantInfo.rows[0].name,
        product_name: variantInfo.rows[0].product_name
      });
    }
    
    const existingRequest = await pool.query(`
      SELECT id, quantity FROM pending_transfers 
      WHERE seller_id = $1 AND variant_id = $2 AND status = 'pending'
    `, [req.userId, variant_id]);
    
    if (existingRequest.rows.length > 0) {
      await pool.query('ROLLBACK');
      return res.status(400).json({ 
        error: `У вас уже есть активная заявка на этот товар!`,
        existing_quantity: existingRequest.rows[0].quantity
      });
    }
    
    await pool.query(`
      UPDATE main_warehouse 
      SET reserved = COALESCE(reserved, 0) + $1 
      WHERE variant_id = $2
    `, [quantity, variant_id]);
    
    const result = await pool.query(`
      INSERT INTO pending_transfers (seller_id, variant_id, quantity, status, created_at)
      VALUES ($1, $2, $3, 'pending', NOW())
      RETURNING id
    `, [req.userId, variant_id, quantity]);
    
    await pool.query('COMMIT');
    
    res.json({ 
      success: true, 
      transfer_id: result.rows[0].id,
      message: `Заявка на перемещение ${quantity} шт ${variantInfo.rows[0].name} создана`,
      available_after: available - quantity
    });
    
  } catch (err) {
    await pool.query('ROLLBACK');
    console.error('Transfer request error:', err);
    res.status(500).json({ error: 'Ошибка при создании заявки' });
  }
});

app.get('/api/manager/tasks', checkManagerAuth, async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT 
        pt.id,
        pt.seller_id,
        u.name as seller_name,
        pt.variant_id,
        v.name as variant_name,
        p.name as product_name,
        pt.quantity,
        pt.status,
        pt.created_at
      FROM pending_transfers pt
      JOIN users u ON pt.seller_id = u.id
      JOIN variants v ON pt.variant_id = v.id
      JOIN products p ON v.product_id = p.id
      WHERE pt.status = 'pending'
      ORDER BY pt.created_at ASC
    `);
    res.json({ tasks: result.rows });
  } catch (err) {
    console.error('Tasks error:', err);
    res.status(500).json({ error: 'Database error' });
  }
});

app.post('/api/manager/tasks/:id/approve', checkManagerAuth, async (req, res) => {
  const { id } = req.params;
  
  try {
    await pool.query('BEGIN');
    
    const transfer = await pool.query(`
      SELECT * FROM pending_transfers WHERE id = $1 AND status = 'pending'
    `, [id]);
    
    if (transfer.rows.length === 0) {
      await pool.query('ROLLBACK');
      return res.status(404).json({ error: 'Заявка не найдена' });
    }
    
    const { seller_id, variant_id, quantity } = transfer.rows[0];
    
    await pool.query(`
      UPDATE main_warehouse 
      SET quantity = quantity - $1, reserved = reserved - $1
      WHERE variant_id = $2
    `, [quantity, variant_id]);
    
    await pool.query(`
      INSERT INTO seller_stock (seller_id, variant_id, quantity, reserved)
      VALUES ($1, $2, $3, 0)
      ON CONFLICT (seller_id, variant_id) 
      DO UPDATE SET quantity = seller_stock.quantity + EXCLUDED.quantity
    `, [seller_id, variant_id, quantity]);
    
    await pool.query(`
      UPDATE pending_transfers 
      SET status = 'approved', updated_at = NOW()
      WHERE id = $1
    `, [id]);
    
    await pool.query(`
      INSERT INTO warehouse_operations (variant_id, source_type, type, quantity, seller_id, user_id, transfer_id, comment)
      VALUES ($1, 'main', 'transfer_out', $2, $3, $4, $5, 'Перемещение продавцу')
    `, [variant_id, quantity, seller_id, req.userId, id]);
    
    await pool.query('COMMIT');
    res.json({ success: true });
  } catch (err) {
    await pool.query('ROLLBACK');
    console.error('Approve task error:', err);
    res.status(500).json({ error: 'Database error' });
  }
});

app.post('/api/manager/tasks/:id/reject', checkManagerAuth, async (req, res) => {
  const { id } = req.params;
  
  try {
    await pool.query('BEGIN');
    
    const transfer = await pool.query(`
      SELECT variant_id, quantity FROM pending_transfers WHERE id = $1 AND status = 'pending'
    `, [id]);
    
    if (transfer.rows.length === 0) {
      await pool.query('ROLLBACK');
      return res.status(404).json({ error: 'Заявка не найдена' });
    }
    
    const { variant_id, quantity } = transfer.rows[0];
    
    await pool.query(`
      UPDATE main_warehouse 
      SET reserved = reserved - $1
      WHERE variant_id = $2
    `, [quantity, variant_id]);
    
    await pool.query(`
      UPDATE pending_transfers 
      SET status = 'rejected', updated_at = NOW()
      WHERE id = $1
    `, [id]);
    
    await pool.query('COMMIT');
    res.json({ success: true });
  } catch (err) {
    await pool.query('ROLLBACK');
    console.error('Reject task error:', err);
    res.status(500).json({ error: 'Database error' });
  }
});

app.get('/api/manager/tasks/completed', checkManagerAuth, async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT 
        pt.id,
        pt.seller_id,
        u.name as seller_name,
        pt.variant_id,
        v.name as variant_name,
        p.name as product_name,
        pt.quantity,
        pt.status,
        pt.created_at,
        pt.updated_at
      FROM pending_transfers pt
      JOIN users u ON pt.seller_id = u.id
      JOIN variants v ON pt.variant_id = v.id
      JOIN products p ON v.product_id = p.id
      WHERE pt.status IN ('approved', 'rejected')
      ORDER BY pt.updated_at DESC
      LIMIT 50
    `);
    res.json({ tasks: result.rows });
  } catch (err) {
    console.error('Completed tasks error:', err);
    res.status(500).json({ error: 'Database error' });
  }
});

app.get('/api/manager/sellers', checkManagerAuth, async (req, res) => {
  const result = await pool.query("SELECT id, name, role FROM users WHERE role IN ('seller', 'admin') ORDER BY name");
  res.json({ sellers: result.rows });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`🚀 Сервер запущен на порту ${PORT}`);
});
