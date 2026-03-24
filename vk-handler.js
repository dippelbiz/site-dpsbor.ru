// vk-handler.js
const fetch = require('node-fetch');

let VK_ACCESS_TOKEN = null;
let VK_GROUP_ID = null;
let VK_CONFIRMATION_CODE = null;
let pool = null;
let vkBindingStates = new Map(); // для диалогов привязки

// Инициализация модуля
function initVK(vkToken, vkGroupId, dbPool, confirmationCode) {
    VK_ACCESS_TOKEN = vkToken;
    VK_GROUP_ID = vkGroupId;
    VK_CONFIRMATION_CODE = confirmationCode;
    pool = dbPool;
    console.log('✅ VK модуль инициализирован');
}

// Отправка сообщения пользователю ВК
async function sendVKMessage(userId, message) {
    if (!VK_ACCESS_TOKEN || !VK_GROUP_ID) {
        console.error('❌ VK_ACCESS_TOKEN или VK_GROUP_ID не заданы');
        return null;
    }
    const params = new URLSearchParams({
        access_token: VK_ACCESS_TOKEN,
        user_id: userId,
        message: message,
        v: '5.131',
        random_id: Math.floor(Math.random() * 1000000)
    });
    try {
        const response = await fetch(`https://api.vk.com/method/messages.send?${params}`);
        const data = await response.json();
        if (data.error) {
            console.error('❌ Ошибка отправки в ВК:', data.error);
            return null;
        }
        console.log(`✅ Сообщение отправлено в VK (userId: ${userId})`);
        return data.response;
    } catch (err) {
        console.error('❌ Ошибка отправки в ВК:', err);
        return null;
    }
}

// Вспомогательная функция привязки заказа к VK ID
async function bindOrderVK(vkId, orderNumber, senderName) {
    // Проверяем существование заказа и его статус
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

    // Если заказ уже привязан к другому VK ID, не меняем (но VK ID может быть разным – оставим пока)
    // Здесь мы не проверяем, так как в таблице orders нет отдельного поля vk_id; будем хранить в contact.
    // Однако для простоты пока будем обновлять contact, а поле user_telegram_id оставим для Telegram.
    // Можно добавить отдельное поле vk_id в таблицу, но пока обойдёмся contact.

    // Обновляем contact (vk_id) и статус (если ещё не processing)
    const updateResult = await pool.query(
        'UPDATE orders SET status = $1 WHERE order_number = $2 AND status != $3',
        ['processing', orderNumber, 'completed']
    );

    // Получаем полные данные заказа для сообщения
    const orderData = await pool.query(`
        SELECT order_number, total, contact, items 
        FROM orders WHERE order_number = $1
    `, [orderNumber]);

    if (orderData.rows.length === 0) {
        console.log(`⚠️ Не удалось получить данные заказа ${orderNumber}`);
        return { success: true, message: `Заказ №${orderNumber} принят в работу! Менеджер скоро свяжется с вами.` };
    }

    const orderRow = orderData.rows[0];
    const contact = typeof orderRow.contact === 'string' ? JSON.parse(orderRow.contact) : orderRow.contact;
    const items = typeof orderRow.items === 'string' ? JSON.parse(orderRow.items) : orderRow.items;

    // Формируем подробное сообщение (аналогично Telegram)
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
        // Обновляем contact, добавляя vk_id и vk_name
        const contactJson = JSON.stringify({
            vk_id: String(vkId),
            vk_name: senderName
        });
        await pool.query(
            `UPDATE orders SET contact = contact || $1::jsonb WHERE order_number = $2`,
            [contactJson, orderNumber]
        );
        // Переносим непривязанные сообщения (если были до привязки)
        await pool.query(
            `UPDATE chat_messages SET order_id = (SELECT id FROM orders WHERE order_number = $2)
             WHERE sender_id = $1::text AND order_id IS NULL AND channel = 'vk'`,
            [String(vkId), orderNumber]
        );
        console.log(`✅ Заказ ${orderNumber} привязан к VK пользователю ${vkId} и переведён в работу`);
        return { success: true, message: messageText };
    } else {
        console.log(`ℹ️ Заказ ${orderNumber} уже в работе (или не требует обновления)`);
        return { success: true, message: messageText };
    }
}

// Основной обработчик вебхука ВК
async function handleVKWebhook(req, res) {
    try {
        const update = req.body;
        // Подтверждение адреса (Callback API требует ответа кодом подтверждения)
        if (update.type === 'confirmation') {
            if (!VK_CONFIRMATION_CODE) {
                console.error('❌ VK_CONFIRMATION_CODE не задан');
                return res.status(500).send('error');
            }
            return res.send(VK_CONFIRMATION_CODE);
        }

        // Обработка нового сообщения
        if (update.type === 'message_new') {
            const message = update.object.message;
            const userId = message.from_id;
            const text = message.text;
            const senderName = `${message.from.first_name} ${message.from.last_name || ''}`.trim() || 'Пользователь ВК';

            // 1. Обработка команды /start order_XXX
            if (text.startsWith('/start order_')) {
                const orderNumber = text.split('_')[1];
                const result = await bindOrderVK(userId, orderNumber, senderName);
                if (result.success) {
                    await sendVKMessage(userId, `✅ ${result.message}`);
                } else {
                    await sendVKMessage(userId, `❌ ${result.message}`);
                }
                return res.send('ok');
            }

            // 2. Обработка команды /start без параметра – начинаем диалог
            if (text === '/start') {
                await sendVKMessage(userId, `Здравствуйте! Введите номер вашего заказа, чтобы связать его с вашим аккаунтом.\n(Номер заказа вы найдёте в уведомлении на сайте)`);
                vkBindingStates.set(userId, { step: 'awaiting_order_number' });
                return res.send('ok');
            }

            // 3. Если пользователь ожидает ввода номера заказа
            if (vkBindingStates.get(userId)?.step === 'awaiting_order_number') {
                const orderNumber = text.trim();
                const result = await bindOrderVK(userId, orderNumber, senderName);
                if (result.success) {
                    await sendVKMessage(userId, `✅ ${result.message}`);
                } else {
                    await sendVKMessage(userId, `❌ ${result.message}`);
                }
                vkBindingStates.delete(userId);
                return res.send('ok');
            }

            // 4. Обычное сообщение – ищем активный заказ по vk_id в contact
            let orderId = null;
            // Ищем заказ, у которого в contact.vk_id = userId и статус processing
            const orderResult = await pool.query(
                `SELECT id FROM orders WHERE contact->>'vk_id' = $1 AND status = $2 ORDER BY created_at DESC LIMIT 1`,
                [String(userId), 'processing']
            );
            if (orderResult.rows.length > 0) {
                orderId = orderResult.rows[0].id;
            } else {
                // Если не нашли – попробуем найти недавний заказ без vk_id (на случай, если пользователь пишет до привязки)
                const recentOrder = await pool.query(
                    `SELECT id FROM orders 
                     WHERE (contact->>'vk_id' IS NULL OR contact->>'vk_id' = '') 
                       AND status = 'processing'
                       AND created_at > NOW() - INTERVAL '10 minutes'
                     ORDER BY created_at DESC LIMIT 1`,
                    []
                );
                if (recentOrder.rows.length > 0) {
                    orderId = recentOrder.rows[0].id;
                    // Автоматически привязываем заказ к этому пользователю
                    const contactJson = JSON.stringify({
                        vk_id: String(userId),
                        vk_name: senderName
                    });
                    await pool.query(
                        `UPDATE orders SET contact = contact || $1::jsonb WHERE id = $2`,
                        [contactJson, orderId]
                    );
                    // Отправляем подтверждение
                    await sendVKMessage(userId, `✅ Ваш заказ автоматически привязан! Мы свяжемся с вами.`);
                    // Отправляем детали заказа (можно сразу отправить подробное сообщение)
                    // Для этого нужно получить данные заказа, как в bindOrderVK.
                    const orderDetails = await pool.query(`
                        SELECT order_number, total, contact, items 
                        FROM orders WHERE id = $1
                    `, [orderId]);
                    if (orderDetails.rows.length > 0) {
                        const row = orderDetails.rows[0];
                        const contact = typeof row.contact === 'string' ? JSON.parse(row.contact) : row.contact;
                        const items = typeof row.items === 'string' ? JSON.parse(row.items) : row.items;
                        let detailsMsg = `✅ Заказ №${row.order_number} принят в работу! Менеджер скоро свяжется с Вами.\n\n`;
                        if (contact.deliveryType === 'pickup') {
                            detailsMsg += `Самовывоз: ${contact.address}\n`;
                        } else if (contact.deliveryType === 'courier') {
                            detailsMsg += `Доставка: ${contact.address}\n`;
                        }
                        if (contact.paymentMethod === 'cash') {
                            detailsMsg += `Оплата: наличными\n`;
                        } else if (contact.paymentMethod === 'transfer') {
                            detailsMsg += `Оплата: перевод по номеру\n`;
                        }
                        detailsMsg += `\nСостав заказа:\n`;
                        items.forEach(item => {
                            const variantDisplay = item.variantName ? item.variantName.replace('Упаковка', 'Уп.') : '';
                            const itemTotal = item.price * item.quantity;
                            detailsMsg += `   ${item.name} (${variantDisplay}) - ${item.quantity} шт = ${itemTotal} руб.\n`;
                        });
                        detailsMsg += `\nСумма заказа: ${row.total} руб.`;
                        await sendVKMessage(userId, detailsMsg);
                    }
                }
            }

            // Сохраняем сообщение в БД
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
                    senderName,
                    text,
                    'incoming',
                    'delivered'
                ]
            );
            console.log(`✅ Сообщение ВК сохранено от пользователя ${userId}`);
        }

        res.send('ok');
    } catch (err) {
        console.error('❌ Ошибка в VK webhook:', err);
        res.status(500).send('error');
    }
}

// Дополнительная функция для проверки инициализации (может понадобиться)
function isInitialized() {
    return !!(VK_ACCESS_TOKEN && VK_GROUP_ID && pool);
}

module.exports = {
    initVK,
    sendVKMessage,
    handleVKWebhook,
    isInitialized
};
