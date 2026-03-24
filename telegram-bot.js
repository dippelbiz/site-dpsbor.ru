// telegram-bot.js
const TelegramBot = require('node-telegram-bot-api');

let bot = null;
let botInitialized = false;
let pool = null;
let orderBindingStates = new Map(); // для диалогов привязки

// Инициализация бота
function initTelegramBot(token, baseUrl, dbPool) {
    if (!token) {
        console.log('⚠️ TELEGRAM_BOT_TOKEN не задан');
        return null;
    }
    pool = dbPool;
    try {
        bot = new TelegramBot(token, { polling: false });

        // Очищаем базовый URL от возможных протоколов и слешей
        let cleanBaseUrl = baseUrl;
        cleanBaseUrl = cleanBaseUrl.replace(/^https?:\/\//, '');
        cleanBaseUrl = cleanBaseUrl.replace(/\/$/, '');
        const webhookUrl = `https://${cleanBaseUrl}/api/telegram/webhook`;

        console.log(`🔗 Установка webhook: ${webhookUrl}`);
        bot.setWebHook(webhookUrl).then(() => {
            console.log(`✅ Telegram webhook установлен: ${webhookUrl}`);
            botInitialized = true;
        }).catch(err => {
            console.error('❌ Ошибка установки webhook:', err.message);
        });
        return bot;
    } catch (err) {
        console.error('❌ Ошибка инициализации бота:', err.message);
        return null;
    }
}

// Отправка сообщения
async function sendTelegramMessage(chatId, text) {
    if (!bot || !botInitialized) {
        console.error('❌ Бот не инициализирован');
        return null;
    }
    try {
        const sent = await bot.sendMessage(chatId, text);
        console.log(`✅ Сообщение отправлено в Telegram (chatId: ${chatId})`);
        return sent;
    } catch (err) {
        console.error('❌ Ошибка отправки сообщения в Telegram:', err.message);
        return null;
    }
}

// Обработка входящего сообщения (для структурирования)
async function handleIncomingMessage(msg) {
    const chatId = msg.chat.id;
    const text = msg.text;
    const from = msg.from;
    console.log(`📨 Telegram сообщение от ${from.id} (${from.first_name}): ${text.substring(0, 50)}${text.length > 50 ? '...' : ''}`);
    return {
        channel: 'telegram',
        externalId: String(msg.message_id),
        senderId: String(from.id),
        senderName: `${from.first_name} ${from.last_name || ''}`.trim() || from.first_name,
        messageText: text,
        chatId: chatId,
        username: from.username,
        firstName: from.first_name,
        lastName: from.last_name
    };
}

// Вспомогательная функция привязки заказа (используется в вебхуке)
async function bindOrder(chatId, orderNumber, senderName) {
    const telegramId = chatId;
    const telegramName = senderName;

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

    if (order.user_telegram_id && order.user_telegram_id !== telegramId) {
        console.log(`⚠️ Заказ ${orderNumber} уже привязан к другому пользователю`);
        return { success: false, message: 'Заказ уже привязан к другому аккаунту' };
    }

    // Обновляем user_telegram_id и статус (если ещё не processing)
    const updateUserResult = await pool.query(
        'UPDATE orders SET user_telegram_id = $1::bigint, status = $2 WHERE order_number = $3 AND status != $4',
        [telegramId, 'processing', orderNumber, 'completed']
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

    // Формируем подробное сообщение
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

    if (updateUserResult.rowCount > 0) {
        // Обновляем JSON contact
        const contactJson = JSON.stringify({
            telegram_id: String(telegramId),
            telegram_name: telegramName
        });
        await pool.query(
            `UPDATE orders SET contact = contact || $1::jsonb WHERE order_number = $2`,
            [contactJson, orderNumber]
        );
        // Переносим непривязанные сообщения
        await pool.query(
            `UPDATE chat_messages SET order_id = (SELECT id FROM orders WHERE order_number = $2)
             WHERE sender_id = $1::text AND order_id IS NULL`,
            [String(telegramId), orderNumber]
        );
        console.log(`✅ Заказ ${orderNumber} привязан к пользователю ${telegramId} и переведён в работу`);
        return { success: true, message: messageText };
    } else {
        // Заказ уже был в работе – отправляем информацию без изменения статуса
        console.log(`ℹ️ Заказ ${orderNumber} уже в работе (или не требует обновления)`);
        return { success: true, message: messageText };
    }
}

// Основной обработчик вебхука
async function handleTelegramWebhook(req, res) {
    try {
        const update = req.body;
        if (update.message && update.message.text) {
            const text = update.message.text;
            const from = update.message.from;
            const chatId = from.id;
            const firstName = from.first_name;
            const username = from.username;
            const senderName = `${firstName}${username ? ` (@${username})` : ''}`.trim();

            // 1. Обработка команды /start order_XXX
            if (text.startsWith('/start order_')) {
                const orderNumber = text.split('_')[1];
                const result = await bindOrder(chatId, orderNumber, senderName);
                if (result.success) {
                    await sendTelegramMessage(chatId, `✅ ${result.message}`);
                } else {
                    await sendTelegramMessage(chatId, `❌ ${result.message}`);
                }
                return res.sendStatus(200);
            }

            // 2. Обработка команды /start без параметра – начинаем диалог
            if (text === '/start') {
                await sendTelegramMessage(chatId, `Здравствуйте! Введите номер вашего заказа, чтобы связать его с вашим аккаунтом.\n(Номер заказа вы найдёте в уведомлении на сайте)`);
                orderBindingStates.set(chatId, { step: 'awaiting_order_number' });
                return res.sendStatus(200);
            }

            // 3. Если пользователь ожидает ввода номера заказа
            if (orderBindingStates.get(chatId)?.step === 'awaiting_order_number') {
                const orderNumber = text.trim();
                const result = await bindOrder(chatId, orderNumber, senderName);
                if (result.success) {
                    await sendTelegramMessage(chatId, `✅ ${result.message}`);
                } else {
                    await sendTelegramMessage(chatId, `❌ ${result.message}`);
                }
                orderBindingStates.delete(chatId);
                return res.sendStatus(200);
            }

            // 4. Обычное сообщение – ищем активный заказ
            const messageData = await handleIncomingMessage(update.message);
            if (!messageData) return res.sendStatus(200);

            let orderId = null;
            const telegramIdNum = parseInt(messageData.senderId, 10);
            if (!isNaN(telegramIdNum)) {
                const orderResult = await pool.query(
                    'SELECT id FROM orders WHERE user_telegram_id = $1 AND status = $2 ORDER BY created_at DESC LIMIT 1',
                    [telegramIdNum, 'processing']
                );
                if (orderResult.rows.length > 0) orderId = orderResult.rows[0].id;
            }

            await pool.query(
                `INSERT INTO chat_messages (
                    order_id, channel, external_id, 
                    sender_id, sender_name, message_text, 
                    direction, status, created_at
                ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, NOW())`,
                [
                    orderId,
                    messageData.channel,
                    messageData.externalId,
                    messageData.senderId,
                    messageData.senderName,
                    messageData.messageText,
                    'incoming',
                    'delivered'
                ]
            );
            console.log(`✅ Сообщение сохранено в БД от ${messageData.senderName} (ID: ${messageData.senderId})`);
        }
        res.sendStatus(200);
    } catch (err) {
        console.error('❌ Ошибка в Telegram webhook:', err);
        res.sendStatus(500);
    }
}

function isInitialized() {
    return botInitialized;
}

function getBot() {
    return bot;
}

module.exports = {
    initTelegramBot,
    sendTelegramMessage,
    handleIncomingMessage,
    isInitialized,
    getBot,
    handleTelegramWebhook
};
