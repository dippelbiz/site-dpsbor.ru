// vk-handler.js
const { Pool } = require('pg');
const fetch = require('node-fetch'); // если нет, нужно установить: npm install node-fetch

// Пул БД будет передан из server.js
let pool = null;
let VK_ACCESS_TOKEN = null;
let VK_GROUP_ID = null;
let vkBindingStates = new Map();

// Инициализация (вызывается из server.js)
function initVK(vkToken, vkGroupId, dbPool) {
    VK_ACCESS_TOKEN = vkToken;
    VK_GROUP_ID = vkGroupId;
    pool = dbPool;
    console.log('✅ VK модуль инициализирован');
}

// Отправка сообщения пользователю ВК
async function sendVKMessage(userId, message) {
    if (!VK_ACCESS_TOKEN) return null;
    try {
        const response = await fetch(`https://api.vk.com/method/messages.send`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
            body: new URLSearchParams({
                access_token: VK_ACCESS_TOKEN,
                user_id: userId,
                message: message,
                v: '5.131',
                random_id: Math.floor(Math.random() * 1000000)
            })
        });
        const data = await response.json();
        if (data.error) {
            console.error('❌ Ошибка отправки в ВК:', data.error);
            return null;
        }
        return data.response;
    } catch (err) {
        console.error('❌ Ошибка отправки в ВК:', err);
        return null;
    }
}

// Вспомогательная функция привязки заказа (общая для VK и TG)
async function bindOrder(chatId, orderNumber, senderName, channel) {
    // channel = 'vk' или 'telegram'
    const updateUserResult = await pool.query(
        `UPDATE orders SET ${channel}_id = $1, status = $2 WHERE order_number = $3 AND status != $4`,
        [chatId, 'processing', orderNumber, 'completed']
    );
    if (updateUserResult.rowCount > 0) {
        const contactJson = JSON.stringify({ [`${channel}_id`]: String(chatId), [`${channel}_name`]: senderName });
        await pool.query(
            `UPDATE orders SET contact = contact || $1::jsonb WHERE order_number = $2`,
            [contactJson, orderNumber]
        );
        // Перенос непривязанных сообщений (можно сделать, если нужно)
        console.log(`✅ Заказ ${orderNumber} привязан к ${channel} пользователю ${chatId}`);
        return { success: true };
    }
    return { success: false };
}

// Получение детальной информации о заказе для отправки
async function getOrderDetails(orderNumber) {
    const orderData = await pool.query(`
        SELECT order_number, total, contact, items 
        FROM orders WHERE order_number = $1
    `, [orderNumber]);
    if (orderData.rows.length === 0) return null;
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
    return messageText;
}

// Вебхук для VK (обработчик входящих сообщений)
async function handleVKWebhook(req, res) {
    try {
        const update = req.body;
        // VK отправляет подтверждение при настройке callback
        if (update.type === 'confirmation') {
            return res.status(200).send(process.env.VK_CONFIRMATION_CODE || 'abc123');
        }
        if (update.type === 'message_new') {
            const message = update.object.message;
            const userId = message.from_id;
            const text = message.text;
            // Логика: если текст начинается с "/start order_XXX" или просто номер заказа
            if (text.startsWith('/start order_')) {
                const orderNumber = text.split('_')[1];
                const result = await bindOrder(userId, orderNumber, `Пользователь VK ${userId}`, 'vk');
                if (result.success) {
                    const details = await getOrderDetails(orderNumber);
                    await sendVKMessage(userId, details);
                } else {
                    await sendVKMessage(userId, '❌ Заказ не найден.');
                }
                return res.status(200).send('ok');
            } else if (/^\d+$/.test(text) && text.length > 2 && text.length < 10) {
                // Возможно, это номер заказа
                const orderNumber = text;
                const result = await bindOrder(userId, orderNumber, `Пользователь VK ${userId}`, 'vk');
                if (result.success) {
                    const details = await getOrderDetails(orderNumber);
                    await sendVKMessage(userId, details);
                } else {
                    await sendVKMessage(userId, '❌ Заказ не найден.');
                }
                return res.status(200).send('ok');
            } else {
                // Обычное сообщение – ищем активный заказ
                const orderResult = await pool.query(
                    'SELECT id FROM orders WHERE vk_id = $1 AND status = $2 ORDER BY created_at DESC LIMIT 1',
                    [userId, 'processing']
                );
                let orderId = null;
                if (orderResult.rows.length > 0) {
                    orderId = orderResult.rows[0].id;
                }
                await pool.query(
                    `INSERT INTO chat_messages (
                        order_id, channel, external_id, 
                        sender_id, sender_name, message_text, 
                        direction, status, created_at
                    ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, NOW())`,
                    [
                        orderId,
                        'vk',
                        String(message.id),
                        String(userId),
                        `Пользователь VK ${userId}`,
                        text,
                        'incoming',
                        'delivered'
                    ]
                );
                console.log(`✅ Сообщение сохранено в БД от VK пользователя ${userId}`);
                return res.status(200).send('ok');
            }
        }
        res.status(200).send('ok');
    } catch (err) {
        console.error('❌ Ошибка в VK webhook:', err);
        res.status(500).send('error');
    }
}

module.exports = {
    initVK,
    sendVKMessage,
    handleVKWebhook
};
