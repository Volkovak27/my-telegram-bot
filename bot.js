require('dotenv').config();
const TelegramBot = require('node-telegram-bot-api');
const fs = require('fs');
const path = require('path');
const XLSX = require('xlsx');

// Папки
const RETENTION_DIR = path.join(__dirname, 'retention');
const OUTPUT_DIR = path.join(__dirname, 'outputs');

// Создаем папки при необходимости
if (!fs.existsSync(RETENTION_DIR)) fs.mkdirSync(RETENTION_DIR, { recursive: true });
if (!fs.existsSync(OUTPUT_DIR)) fs.mkdirSync(OUTPUT_DIR, { recursive: true });

// Валютные коды
const SOE_CODES = ['AZN','BDT','BRL','CLP','COP','CZK','EGP','EUR','HUF','INR','KGS','KZT','LKP','MAD','MXN','NPR','PEN','PKR','PLN','RUB','TND','TRY','USD','UZS'];
const EC_CODES = ['UAH','BYN','CAD','SEK','VND'];

const getFilename = (size, codeList) => {
  const uniqueCodes = [...new Set(codeList)];
  const hasECCode = uniqueCodes.some(code => EC_CODES.includes(code));
  const hasSOECode = uniqueCodes.some(code => SOE_CODES.includes(code));

  let gameName = 'Unknown_Game';
  if (hasECCode && !hasSOECode) gameName = 'MB_Energy_Coins_Hold_and_Win';
  else gameName = 'MB_Sun_of_Egypt_3';

  return `Birthday_freespins_${gameName}_v${size}_crm.csv`;
};

const TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const bot = new TelegramBot(TOKEN, { polling: true });

bot.onText(/\/start/, (msg) => {
  const chatId = msg.chat.id;

  const keyboard = {
    reply_markup: {
      keyboard: [
        [{ text: '🎰 Разделить на фриспины' }]
      ],
      resize_keyboard: true,
      one_time_keyboard: false
    }
  };

  bot.sendMessage(chatId, 'Привет! Выберите действие:', keyboard);
});

bot.on('message', (msg) => {
  const chatId = msg.chat.id;

  if (msg.text === '🎰 Разделить на фриспины') {
    bot.sendMessage(chatId, 'Отправь мне Excel-файл (.xlsx), и я разделю его на группы по размеру фриспинов и пришлю CSV-файлы.');
  }
});

bot.on('document', async (msg) => {
  const chatId = msg.chat.id;
  const fileId = msg.document.file_id;
  const fileName = msg.document.file_name;

  if (!fileName.endsWith('.xlsx')) {
    return bot.sendMessage(chatId, "Пожалуйста, отправьте файл формата .xlsx");
  }

  const fileLink = await bot.getFileLink(fileId);
  const filePath = path.join(RETENTION_DIR, fileName);

  try {
    const res = await fetch(fileLink);
    const buffer = await res.arrayBuffer();
    fs.writeFileSync(filePath, Buffer.from(buffer));
    bot.sendMessage(chatId, "Файл получен. Обрабатываю...");

    // Обработка файла
    const workbook = XLSX.readFile(filePath);
    let allData = [];

    workbook.SheetNames.forEach(sheetName => {
      const sheet = workbook.Sheets[sheetName];
      const data = XLSX.utils.sheet_to_json(sheet);
      const processed = data.map(row => ({ ...row, user_id: row.user_id ?? null }));
      allData = allData.concat(processed);
    });

    const grouped = {};
    allData.forEach(row => {
      const size = row['Freespin_size'] ?? row['FS'] ?? 'undefined';
      if (!grouped[size]) grouped[size] = [];
      grouped[size].push(row);
    });

    const resultFiles = [];

    Object.entries(grouped).forEach(([size, rows]) => {
      const uniqueRows = [];
      const seenUserIds = new Set();
      const codeList = [];

      rows.forEach(row => {
        if (!seenUserIds.has(row.user_id)) {
          seenUserIds.add(row.user_id);
          uniqueRows.push(row);
          if (row.code) codeList.push(String(row.code).trim());
        }
      });

      const filtered = uniqueRows.map(r => ({ user_id: r.user_id }));
      const ws = XLSX.utils.json_to_sheet(filtered, { header: ['user_id'] });
      const csv = XLSX.utils.sheet_to_csv(ws);
      const outputFile = path.join(OUTPUT_DIR, getFilename(size, codeList));

      fs.writeFileSync(outputFile, csv, 'utf8');
      resultFiles.push(outputFile);
    });

    if (resultFiles.length) {
      for (const file of resultFiles) {
        await bot.sendDocument(chatId, file);
      }
      bot.sendMessage(chatId, "Готово ✅");
    } else {
      bot.sendMessage(chatId, "Файл обработан, но подходящих данных не найдено.");
    }
  } catch (err) {
    console.error(err);
    bot.sendMessage(chatId, "Произошла ошибка при обработке файла.");
  }
});
