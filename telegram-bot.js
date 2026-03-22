// telegram-bot.js
const TelegramBot = require('node-telegram-bot-api');

let bot = null;
let botInitialized = false;

// Функция инициализации бота
function initTelegramBot(token, webhookUrl) {
    if (!token) {
        console.log('⚠️ TELEGRAM_BOT_TOKEN не задан, бот не запущен');
        return null;
    }
    
    try {
        // Создаем экземпляр бота без polling, будем использовать webhook
        bot = new TelegramBot(token, { polling: false });
        
        // Устанавливаем вебхук
        const webhookPath = `${webhookUrl}/api/telegram/webhook`;
        
        bot.setWebHook(webhookPath).then(() => {
            console.log(`✅ Telegram webhook установлен: ${webhookPath}`);
            botInitialized = true;
        }).catch(err => {
            console.error('❌ Ошибка установки webhook:', err.message);
        });
        
        console.log('🤖 Telegram бот инициализирован');
        return bot;
        
    } catch (err) {
        console.error('❌ Ошибка инициализации Telegram бота:', err.message);
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
        return sent;
    } catch (err) {
        console.error('❌ Ошибка отправки сообщения в Telegram:', err.message);
        return null;
    }
}

// Функция обработки входящего сообщения (будет вызываться из server.js)
async function handleIncomingMessage(msg) {
    const chatId = msg.chat.id;
    const text = msg.text;
    const from = msg.from;
    
    console.log(`📨 Telegram сообщение от ${from.id} (${from.first_name}): ${text.substring(0, 50)}`);
    
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

// Экспортируем функции
module.exports = {
    initTelegramBot,
    sendTelegramMessage,
    handleIncomingMessage,
    getBot: () => bot,
    isInitialized: () => botInitialized
};
