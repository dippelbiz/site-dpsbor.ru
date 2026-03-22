// telegram-bot.js
const TelegramBot = require('node-telegram-bot-api');

let bot = null;
let botInitialized = false;

// Функция инициализации бота
function initTelegramBot(token, baseUrl) {
    if (!token) {
        console.log('⚠️ TELEGRAM_BOT_TOKEN не задан');
        return null;
    }
    
    try {
        bot = new TelegramBot(token, { polling: false });
        
        // Формируем URL для webhook
        let webhookUrl = `${baseUrl}/api/telegram/webhook`;
        
        // Убеждаемся, что URL использует HTTPS для продакшена
        if (process.env.NODE_ENV === 'production' && !webhookUrl.startsWith('https://')) {
            webhookUrl = webhookUrl.replace('http://', 'https://');
            console.log(`🔄 Исправлен протокол на HTTPS: ${webhookUrl}`);
        }
        
        console.log(`🔗 Установка webhook: ${webhookUrl}`);
        
        bot.setWebHook(webhookUrl).then(() => {
            console.log(`✅ Telegram webhook установлен: ${webhookUrl}`);
            botInitialized = true;
        }).catch(err => {
            console.error('❌ Ошибка установки webhook:', err.message);
            console.error('   Проверьте, что URL доступен из интернета');
        });
        
        return bot;
    } catch (err) {
        console.error('❌ Ошибка инициализации бота:', err.message);
        return null;
    }
}

// Функция отправки сообщения
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

// Функция обработки входящего сообщения
async function handleIncomingMessage(msg) {
    const chatId = msg.chat.id;
    const text = msg.text;
    const from = msg.from;
    
    console.log(`📨 Telegram сообщение от ${from.id} (${from.first_name}): ${text.substring(0, 50)}${text.length > 50 ? '...' : ''}`);
    
    return {
        channel: 'telegram',
        externalId: String(msg.message_id),
        senderId: String(from.id),
        senderName: `${from.first_name} ${from.last_name || ''}`.trim() || from.username,
        messageText: text,
        chatId: chatId,
        username: from.username,
        firstName: from.first_name,
        lastName: from.last_name
    };
}

// Получить статус бота
function isInitialized() {
    return botInitialized;
}

// Получить экземпляр бота
function getBot() {
    return bot;
}

// Экспортируем функции
module.exports = {
    initTelegramBot,
    sendTelegramMessage,
    handleIncomingMessage,
    isInitialized,
    getBot
};
