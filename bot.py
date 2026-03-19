import os
import logging
import json
import requests
from datetime import datetime
from telegram import Update, InlineKeyboardButton, InlineKeyboardMarkup
from telegram.ext import Application, CommandHandler, MessageHandler, filters, ContextTypes
import psycopg2
from psycopg2.extras import RealDictCursor

# Настройка логирования
logging.basicConfig(
    format='%(asctime)s - %(name)s - %(levelname)s - %(message)s',
    level=logging.INFO
)
logger = logging.getLogger(__name__)

# Переменные окружения
BOT_TOKEN = os.getenv('BOT_TOKEN')  # Токен вашего бота @dpsbor_site_bot
DATABASE_URL = os.getenv('DATABASE_URL')  # URL базы данных Supabase
SITE_URL = os.getenv('SITE_URL', 'https://dpsbor.ru')  # Адрес вашего сайта

def get_db_connection():
    """Подключение к базе данных"""
    return psycopg2.connect(DATABASE_URL, cursor_factory=RealDictCursor)

def get_order_by_number(order_number: str):
    """Получение заказа по номеру"""
    logger.info(f"🔍 Поиск заказа с номером '{order_number}'")
    with get_db_connection() as conn:
        with conn.cursor() as cur:
            cur.execute("SELECT * FROM orders WHERE order_number = %s", (order_number,))
            order = cur.fetchone()
            if order:
                # Парсим JSON поля
                order['items'] = json.loads(order['items']) if order['items'] else []
                order['contact'] = json.loads(order['contact']) if order['contact'] else {}
            return order

def get_user_orders(user_id: int):
    """Получение всех заказов пользователя"""
    with get_db_connection() as conn:
        with conn.cursor() as cur:
            cur.execute(
                "SELECT * FROM orders WHERE user_id = %s ORDER BY id DESC LIMIT 5",
                (user_id,)
            )
            orders = cur.fetchall()
            for order in orders:
                order['items'] = json.loads(order['items']) if order['items'] else []
                order['contact'] = json.loads(order['contact']) if order['contact'] else {}
            return orders

def format_order_message(order):
    """Форматирование заказа для отправки в Telegram"""
    if not order:
        return "❌ Заказ не найден"
    
    # Статус заказа
    status_emoji = {
        'Активный': '🟢',
        'Завершен': '✅',
        'Отменен': '❌'
    }.get(order['status'], '⚪️')
    
    # Состав заказа
    items_text = ""
    for item in order['items']:
        variant = item.get('variantName', '')
        variant_text = f" ({variant})" if variant else ""
        items_text += f"• {item['name']}{variant_text} x{item['quantity']} = {item['price'] * item['quantity']} руб.\n"
    
    # Контактная информация
    contact = order['contact']
    delivery_type = "Самовывоз" if contact.get('deliveryType') == 'pickup' else "Доставка"
    payment = "Наличные" if contact.get('paymentMethod') == 'cash' else "Перевод"
    
    # Формируем сообщение
    message = f"""
{status_emoji} *Заказ №{order['order_number']}*

📦 *Состав заказа:*
{items_text}
💰 *Итого:* {order['total']} руб.

🚚 *Способ получения:* {delivery_type}
📍 *Адрес:* {contact.get('address', 'Не указан')}
💳 *Оплата:* {payment}

📅 *Дата заказа:* {order['created_at'].strftime('%d.%m.%Y %H:%M') if order.get('created_at') else 'Неизвестно'}

💬 Если у вас есть вопросы, просто напишите их в этот чат.
    """
    return message

async def start(update: Update, context: ContextTypes.DEFAULT_TYPE):
    """Обработчик команды /start"""
    user = update.effective_user
    args = context.args  # Параметры после команды /start
    
    logger.info(f"👤 Пользователь @{user.username} (id: {user.id}) запустил бота с параметрами: {args}")
    
    # Приветственное сообщение
    welcome_text = f"""
👋 *Здравствуйте, {user.first_name}!*

Я — бот магазина *ДП СБОР*. Здесь вы можете:
• Получить информацию о ваших заказах
• Задать вопросы по заказу
• Связаться с поддержкой

🔍 Чтобы узнать детали заказа, отправьте мне его номер, например: `А123`
    """
    
    # Если передан параметр с заказом (например, order_123)
    if args and args[0].startswith('order_'):
        order_number = args[0][6:]  # Убираем "order_"
        order = get_order_by_number(order_number)
        
        if order:
            # Проверяем, принадлежит ли заказ этому пользователю
            if order['user_id'] == user.id:
                order_text = format_order_message(order)
                await update.message.reply_text(
                    order_text,
                    parse_mode='Markdown'
                )
            else:
                await update.message.reply_text(
                    "❌ Этот заказ не принадлежит вам.\n"
                    f"Ваш ID: {user.id}\n"
                    f"ID владельца заказа: {order['user_id']}"
                )
        else:
            await update.message.reply_text(
                f"❌ Заказ с номером {order_number} не найден.\n"
                "Проверьте номер заказа и попробуйте снова."
            )
    
    # Отправляем приветствие (если нет заказа или заказ показали)
    await update.message.reply_text(
        welcome_text,
        parse_mode='Markdown'
    )
    
    # Показываем последние заказы пользователя
    orders = get_user_orders(user.id)
    if orders:
        keyboard = []
        for order in orders[:3]:  # Показываем только 3 последних
            button = InlineKeyboardButton(
                f"📋 Заказ {order['order_number']}",
                callback_data=f"order_{order['order_number']}"
            )
            keyboard.append([button])
        
        reply_markup = InlineKeyboardMarkup(keyboard)
        await update.message.reply_text(
            "Ваши последние заказы:",
            reply_markup=reply_markup
        )

async def handle_message(update: Update, context: ContextTypes.DEFAULT_TYPE):
    """Обработчик текстовых сообщений"""
    user = update.effective_user
    text = update.message.text.strip()
    
    logger.info(f"💬 Сообщение от @{user.username}: {text}")
    
    # Проверяем, является ли сообщение номером заказа
    # Поддерживаем форматы: А123, А1, D45, и т.д.
    import re
    order_pattern = r'^[A-Za-zА-Яа-я]{1,3}\d+$'
    
    if re.match(order_pattern, text):
        # Ищем заказ по номеру
        order = get_order_by_number(text)
        
        if order:
            # Проверяем, принадлежит ли заказ этому пользователю
            if order['user_id'] == user.id:
                order_text = format_order_message(order)
                await update.message.reply_text(
                    order_text,
                    parse_mode='Markdown'
                )
            else:
                await update.message.reply_text(
                    "❌ Этот заказ не принадлежит вам.\n"
                    f"Ваш ID: {user.id}\n"
                    f"ID владельца заказа: {order['user_id']}"
                )
        else:
            await update.message.reply_text(
                f"❌ Заказ с номером {text} не найден.\n"
                "Проверьте номер заказа и попробуйте снова."
            )
    else:
        # Если это не номер заказа, пересылаем сообщение администратору
        # Здесь можно добавить логику пересылки в CRM или на email
        await update.message.reply_text(
            "✅ Ваше сообщение передано поддержке. Мы ответим вам в ближайшее время."
        )
        
        # Уведомление администратору (опционально)
        admin_chat_id = os.getenv('ADMIN_CHAT_ID')
        if admin_chat_id:
            try:
                await context.bot.send_message(
                    chat_id=admin_chat_id,
                    text=f"💬 Сообщение от @{user.username} (id: {user.id}):\n\n{text}"
                )
            except Exception as e:
                logger.error(f"Ошибка отправки админу: {e}")

async def callback_handler(update: Update, context: ContextTypes.DEFAULT_TYPE):
    """Обработчик нажатий на инлайн-кнопки"""
    query = update.callback_query
    await query.answer()
    
    user = update.effective_user
    data = query.data
    
    logger.info(f"🔘 Нажатие кнопки от @{user.username}: {data}")
    
    if data.startswith('order_'):
        order_number = data[6:]
        order = get_order_by_number(order_number)
        
        if order and order['user_id'] == user.id:
            order_text = format_order_message(order)
            await query.edit_message_text(
                order_text,
                parse_mode='Markdown'
            )
        else:
            await query.edit_message_text(
                "❌ Заказ не найден или не принадлежит вам."
            )

async def help_command(update: Update, context: ContextTypes.DEFAULT_TYPE):
    """Обработчик команды /help"""
    help_text = """
ℹ️ *Как пользоваться ботом*

• Чтобы узнать детали заказа, отправьте его номер (например, `А123`)
• Вы также можете нажать на кнопку с заказом в списке
• Если у вас есть вопросы, просто напишите их в чат — мы ответим

📍 *Наш сайт:* {site_url}
    """.format(site_url=SITE_URL)
    
    await update.message.reply_text(
        help_text,
        parse_mode='Markdown'
    )

async def my_orders(update: Update, context: ContextTypes.DEFAULT_TYPE):
    """Обработчик команды /myorders"""
    user = update.effective_user
    orders = get_user_orders(user.id)
    
    if not orders:
        await update.message.reply_text(
            "У вас пока нет заказов.\n"
            f"Посетите наш сайт: {SITE_URL}"
        )
        return
    
    keyboard = []
    for order in orders:
        button = InlineKeyboardButton(
            f"📋 Заказ {order['order_number']} ({order['status']})",
            callback_data=f"order_{order['order_number']}"
        )
        keyboard.append([button])
    
    reply_markup = InlineKeyboardMarkup(keyboard)
    await update.message.reply_text(
        "Ваши заказы:",
        reply_markup=reply_markup
    )

def main():
    """Запуск бота"""
    if not BOT_TOKEN:
        logger.error("❌ Не задан BOT_TOKEN в переменных окружения")
        return
    
    # Создаем приложение
    application = Application.builder().token(BOT_TOKEN).build()
    
    # Добавляем обработчики
    application.add_handler(CommandHandler("start", start))
    application.add_handler(CommandHandler("help", help_command))
    application.add_handler(CommandHandler("myorders", my_orders))
    application.add_handler(MessageHandler(filters.TEXT & ~filters.COMMAND, handle_message))
    application.add_handler(CallbackQueryHandler(callback_handler))
    
    logger.info("✅ Бот запущен и готов к работе")
    
    # Запускаем бота
    application.run_polling(allowed_updates=Update.ALL_TYPES)

if __name__ == '__main__':
    main()
