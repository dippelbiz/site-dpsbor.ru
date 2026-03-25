// max-handler.js
let MAX_BOT_TOKEN = null;
let MAX_BOT_NAME = null;
let pool = null;
let maxBindingStates = new Map();

const API_BASE = 'https://platform-api.max.ru';

async function initMAX(token, botName, dbPool) {
    MAX_BOT_TOKEN = token;
    MAX_BOT_NAME = botName;
    pool = dbPool;
    console.log('✅ MAX модуль инициализирован');

    const webhookUrl = `${process.env.SITE_URL || 'https://dpsbor.ru'}/api/max/webhook`;
    try {
        const response = await fetch(`${API_BASE}/subscriptions`, {
            method: 'POST',
            headers: {
                'Authorization': MAX_BOT_TOKEN,
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({ url: webhookUrl })
        });
        const data = await response.json();
        if (data.error) {
            console.error('❌ Ошибка подписки MAX webhook:', data.error);
        } else {
            console.log(`✅ MAX webhook подписан: ${webhookUrl}`);
        }
    } catch (err) {
        console.error('❌ Ошибка подписки MAX webhook:', err.message);
    }
}

// Отправка сообщения – используем user_id (получатель в диалоге)
async function sendMAXMessage(userId, text) {
    if (!MAX_BOT_TOKEN) {
        console.error('❌ MAX_BOT_TOKEN не задан');
        return null;
    }
    const url = `${API_BASE}/messages`;
    const body = {
        user_id: userId,      // ← основной кандидат по документации
        text: text
    };
    console.log(`📤 Отправка в MAX: url=${url}, body=${JSON.stringify(body)}`);
    try {
        const response = await fetch(url, {
            method: 'POST',
            headers: {
                'Authorization': MAX_BOT_TOKEN,
                'Content-Type': 'application/json'
            },
            body: JSON.stringify(body)
        });
        const data = await response.json();
        console.log(`📨 Ответ MAX API: ${JSON.stringify(data)}`);
        if (response.status !== 200) {
            console.error('❌ Ошибка отправки в MAX:', data);
            return null;
        }
        console.log(`✅ Сообщение отправлено в MAX (userId: ${userId})`);
        return data.message_id;
    } catch (err) {
        console.error('❌ Ошибка отправки в MAX:', err);
        return null;
    }
}

async function bindOrderMAX(maxId, orderNumber, senderName) {
    console.log(`🔍 bindOrderMAX: maxId=${maxId}, orderNumber=${orderNumber}, senderName=${senderName}`);
    const orderCheck = await pool.query(
        'SELECT id, status FROM orders WHERE order_number = $1',
        [orderNumber]
    );
    if (orderCheck.rows.length === 0) {
        console.log(`⚠️ Заказ ${orderNumber} не найден для привязки`);
        return { success: false, message: 'Заказ не найден' };
    }

    const order = orderCheck.rows[0];
    if (order.status === 'completed') {
        console.log(`⚠️ Заказ ${orderNumber} уже завершён, привязка не требуется`);
        return { success: false, message: 'Заказ уже завершён' };
    }

    const updateResult = await pool.query(
        'UPDATE orders SET status = $1 WHERE order_number = $2 AND status != $3',
        ['processing', orderNumber, 'completed']
    );

    const orderData = await pool.query(`
        SELECT order_number, total, contact, items 
        FROM orders WHERE order_number = $1
    `, [orderNumber]);

    if (orderData.rows.length === 0) {
        return { success: true, message: `Заказ №${orderNumber} принят в работу! Менеджер скоро свяжется с вами.` };
    }

    const orderRow = orderData.rows[0];
    const contact = typeof orderRow.contact === 'string' ? JSON.parse(orderRow.contact) : orderRow.contact;
    const items = typeof orderRow.items === 'string' ? JSON.parse(orderRow.items) : orderRow.items;

    let messageText = `✅ Заказ №${orderRow.order_number} принят в работу! Менеджер скоро свяжется с Вами.\n\n`;
    if (contact.deliveryType === 'pickup') {
        messageText += `Самовывоз: ${contact.address}\n`;
    } else if (contact.deliveryType === 'courier') {
        messageText += `Доставка: ${contact.address}\n`;
    }
    if (contact.paymentMethod === 'cash') {
        messageText += `Оплата: наличными\n`;
    } else if (contact.paymentMethod === 'transfer') {
        messageText += `Оплата: перевод по номеру\n`;
    }
    messageText += `\nСостав заказа:\n`;
    items.forEach(item => {
        const variantDisplay = item.variantName ? item.variantName.replace('Упаковка', 'Уп.') : '';
        const itemTotal = item.price * item.quantity;
        messageText += `   ${item.name} (${variantDisplay}) - ${item.quantity} шт = ${itemTotal} руб.\n`;
    });
    messageText += `\nСумма заказа: ${orderRow.total} руб.`;

    if (updateResult.rowCount > 0) {
        const contactJson = JSON.stringify({
            max_id: String(maxId),
            max_name: senderName
        });
        await pool.query(
            `UPDATE orders SET contact = contact || $1::jsonb WHERE order_number = $2`,
            [contactJson, orderNumber]
        );
        await pool.query(
            `UPDATE chat_messages SET order_id = (SELECT id FROM orders WHERE order_number = $2)
             WHERE sender_id = $1::text AND order_id IS NULL AND channel = 'max'`,
            [String(maxId), orderNumber]
        );
        console.log(`✅ Заказ ${orderNumber} привязан к MAX пользователю ${maxId}`);
        return { success: true, message: messageText };
    } else {
        console.log(`ℹ️ Заказ ${orderNumber} уже в работе (или не требует обновления)`);
        return { success: true, message: messageText };
    }
}

async function handleMAXWebhook(req, res) {
    console.log('📨 MAX webhook вызван');
    try {
        const update = req.body;
        console.log('📨 MAX webhook body:', JSON.stringify(update));

        if (update.update_type === 'bot_started') {
            const userId = update.user.user_id;           // ← правильный получатель
            const userName = update.user.name || `Пользователь MAX ${userId}`;
            const payload = update.payload;

            if (payload && payload.startsWith('order_')) {
                const orderNumber = payload.split('_')[1];
                const result = await bindOrderMAX(userId, orderNumber, userName);
                if (result.success) {
                    const sent = await sendMAXMessage(userId, `✅ ${result.message}`);
                    if (!sent) console.error('❌ Не удалось отправить сообщение при привязке');
                } else {
                    await sendMAXMessage(userId, `❌ ${result.message}`);
                }
                return res.send('ok');
            } else {
                await sendMAXMessage(userId, `Здравствуйте! Введите номер вашего заказа, чтобы связать его с вашим аккаунтом.\n(Номер заказа вы найдёте в уведомлении на сайте)`);
                maxBindingStates.set(userId, { step: 'awaiting_order_number', userId });
                return res.send('ok');
            }
        }

        if (update.update_type === 'message_created') {
            const message = update.message;
            const userId = message.sender.user_id;       // ← правильный получатель
            const userName = message.sender.name || `Пользователь MAX ${userId}`;
            const text = message.body.text;

            if (maxBindingStates.get(userId)?.step === 'awaiting_order_number') {
                const orderNumber = text.trim();
                const result = await bindOrderMAX(userId, orderNumber, userName);
                if (result.success) {
                    const sent = await sendMAXMessage(userId, `✅ ${result.message}`);
                    if (!sent) console.error('❌ Не удалось отправить сообщение при привязке');
                } else {
                    await sendMAXMessage(userId, `❌ ${result.message}`);
                }
                maxBindingStates.delete(userId);
                return res.send('ok');
            }

            if (/^[A-Za-zА-Яа-я]+\d+$/.test(text)) {
                const orderNumber = text;
                const result = await bindOrderMAX(userId, orderNumber, userName);
                if (result.success) {
                    const sent = await sendMAXMessage(userId, `✅ ${result.message}`);
                    if (!sent) console.error('❌ Не удалось отправить сообщение при привязке');
                } else {
                    await sendMAXMessage(userId, `❌ ${result.message}`);
                }
                return res.send('ok');
            }

            let orderId = null;
            const orderResult = await pool.query(
                `SELECT id FROM orders WHERE contact->>'max_id' = $1 AND status = $2 ORDER BY created_at DESC LIMIT 1`,
                [String(userId), 'processing']
            );
            if (orderResult.rows.length > 0) {
                orderId = orderResult.rows[0].id;
            } else {
                const recentOrder = await pool.query(
                    `SELECT id FROM orders 
                     WHERE (contact->>'max_id' IS NULL OR contact->>'max_id' = '') 
                       AND status = 'processing'
                       AND created_at > NOW() - INTERVAL '10 minutes'
                     ORDER BY created_at DESC LIMIT 1`,
                    []
                );
                if (recentOrder.rows.length > 0) {
                    orderId = recentOrder.rows[0].id;
                    const contactJson = JSON.stringify({
                        max_id: String(userId),
                        max_name: userName
                    });
                    await pool.query(
                        `UPDATE orders SET contact = contact || $1::jsonb WHERE id = $2`,
                        [contactJson, orderId]
                    );
                    await sendMAXMessage(userId, `✅ Ваш заказ автоматически привязан! Мы свяжемся с вами.`);
                    const orderDetails = await pool.query(`SELECT order_number, total, contact, items FROM orders WHERE id = $1`, [orderId]);
                    if (orderDetails.rows.length > 0) {
                        const row = orderDetails.rows[0];
                        const contact = typeof row.contact === 'string' ? JSON.parse(row.contact) : row.contact;
                        const items = typeof row.items === 'string' ? JSON.parse(row.items) : row.items;
                        let detailsMsg = `✅ Заказ №${row.order_number} принят в работу! Менеджер скоро свяжется с Вами.\n\n`;
                        if (contact.deliveryType === 'pickup') detailsMsg += `Самовывоз: ${contact.address}\n`;
                        else if (contact.deliveryType === 'courier') detailsMsg += `Доставка: ${contact.address}\n`;
                        if (contact.paymentMethod === 'cash') detailsMsg += `Оплата: наличными\n`;
                        else if (contact.paymentMethod === 'transfer') detailsMsg += `Оплата: перевод по номеру\n`;
                        detailsMsg += `\nСостав заказа:\n`;
                        items.forEach(item => {
                            const variantDisplay = item.variantName ? item.variantName.replace('Упаковка', 'Уп.') : '';
                            const itemTotal = item.price * item.quantity;
                            detailsMsg += `   ${item.name} (${variantDisplay}) - ${item.quantity} шт = ${itemTotal} руб.\n`;
                        });
                        detailsMsg += `\nСумма заказа: ${row.total} руб.`;
                        await sendMAXMessage(userId, detailsMsg);
                    }
                }
            }

            if (orderId) {
                await pool.query(
                    `INSERT INTO chat_messages (order_id, channel, external_id, sender_id, sender_name, message_text, direction, status, created_at)
                     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, NOW())`,
                    [orderId, 'max', String(message.body.mid), String(userId), userName, text, 'incoming', 'delivered']
                );
                console.log(`✅ Сообщение MAX сохранено от пользователя ${userId}`);
            }
        }

        res.send('ok');
    } catch (err) {
        console.error('❌ Ошибка в MAX webhook:', err);
        res.status(500).send('error');
    }
}

function isInitialized() {
    return !!(MAX_BOT_TOKEN && MAX_BOT_NAME && pool);
}

module.exports = { initMAX, sendMAXMessage, handleMAXWebhook, isInitialized };
