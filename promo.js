require('dotenv').config();
const TelegramBot = require('node-telegram-bot-api');
const XLSX = require('xlsx');
const fs = require('fs');
const path = require('path');
const fetch = require('node-fetch');

const TOKEN = process.env.TELEGRAM_BOT_TOKEN;
if (!TOKEN) {
  console.error('Ошибка: TELEGRAM_BOT_TOKEN не найден в .env');
  process.exit(1);
}

const bot = new TelegramBot(TOKEN, { polling: true });
const OUTPUT_DIR = path.join(__dirname, 'outputs');
if (!fs.existsSync(OUTPUT_DIR)) fs.mkdirSync(OUTPUT_DIR, { recursive: true });

console.log('Бот запущен');

bot.onText(/\/start/, (msg) => {
  const chatId = msg.chat.id;
  const opts = {
    reply_markup: {
      keyboard: [[{ text: 'Разделить на промокоды' }]],
      resize_keyboard: true,
      one_time_keyboard: true
    }
  };
  bot.sendMessage(chatId, 'Привет! Нажми кнопку ниже и отправь Excel-файл (.xlsx), я разделю его по промогруппам.', opts);
});

let awaitingPromoFile = {};

bot.on('message', async (msg) => {
  const chatId = msg.chat.id;
  console.log(`Получено сообщение от ${chatId}:`, msg.text || 'файл');

  if (msg.text === 'Разделить на промокоды') {
    awaitingPromoFile[chatId] = true;
    return bot.sendMessage(chatId, 'Хорошо! Отправь Excel-файл (.xlsx), я обработаю его.');
  }

  if (msg.document && awaitingPromoFile[chatId]) {
    delete awaitingPromoFile[chatId];

    const fileId = msg.document.file_id;
    const fileName = msg.document.file_name;

    if (!fileName.endsWith('.xlsx')) {
      return bot.sendMessage(chatId, "Пожалуйста, отправьте файл формата .xlsx");
    }

    try {
      const fileLink = await bot.getFileLink(fileId);
      console.log('Ссылка на файл:', fileLink);

      const res = await fetch(fileLink);
      const buffer = await res.arrayBuffer();

      const tempFilePath = path.join(__dirname, `temp_${chatId}.xlsx`);
      fs.writeFileSync(tempFilePath, Buffer.from(buffer));

      bot.sendMessage(chatId, 'Обрабатываю файл...');

      const workbook = XLSX.readFile(tempFilePath);
      let allData = [];

      workbook.SheetNames.forEach(sheetName => {
        const sheet = workbook.Sheets[sheetName];
        const data = XLSX.utils.sheet_to_json(sheet, { header: 1 });

        const headers = data[0];
        if (!headers) return;

        const userIdIndex = headers.findIndex(h => h === 'user_id');
        const promoIndex = headers.findIndex(h =>
          h?.toString().toLowerCase().includes('promo')
        );

        if (userIdIndex === -1 || promoIndex === -1) {
          return;
        }

        for (let i = 1; i < data.length; i++) {
          const row = data[i];
          const user_id = row[userIdIndex];
          const promoValue = row[promoIndex];

          if (user_id && promoValue) {
            allData.push({ user_id, group: promoValue });
          }
        }
      });

      const grouped = {};
      allData.forEach(row => {
        if (!grouped[row.group]) grouped[row.group] = [];
        grouped[row.group].push(row);
      });

      if (Object.keys(grouped).length === 0) {
        await bot.sendMessage(chatId, 'Не удалось найти данные для группировки.');
        fs.unlinkSync(tempFilePath);
        return;
      }

      const resultFiles = [];

      Object.entries(grouped).forEach(([group, rows]) => {
        const safeGroup = String(group).replace(/[^a-zA-Z0-9_-]/g, '_');
        const userIdOnly = rows.map(row => ({ user_id: row.user_id }));
        const ws = XLSX.utils.json_to_sheet(userIdOnly, { header: ['user_id'] });
        const csv = XLSX.utils.sheet_to_csv(ws);
        const outputFile = path.join(OUTPUT_DIR, `${safeGroup}.csv`);
        fs.writeFileSync(outputFile, csv, 'utf8');
        resultFiles.push(outputFile);
      });

      for (const file of resultFiles) {
        await bot.sendDocument(chatId, file);
      }
      await bot.sendMessage(chatId, 'Готово ✅');

      fs.unlinkSync(tempFilePath);

    } catch (err) {
      console.error('Ошибка при обработке файла:', err);
      bot.sendMessage(chatId, 'Произошла ошибка при обработке файла.');
    }
  }
});
