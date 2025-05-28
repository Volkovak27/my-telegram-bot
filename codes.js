require('dotenv').config();
const TelegramBot = require('node-telegram-bot-api');
const fs = require('fs');
const path = require('path');

const TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const bot = new TelegramBot(TOKEN, { polling: true });

const TEMP_DIR = path.join(__dirname, 'temp_files');
const OUTPUT_DIR = path.join(__dirname, 'outputs');

if (!fs.existsSync(TEMP_DIR)) fs.mkdirSync(TEMP_DIR, { recursive: true });
if (!fs.existsSync(OUTPUT_DIR)) fs.mkdirSync(OUTPUT_DIR, { recursive: true });

const userFiles = {}; // { chatId: [ {filePath, originalName} ] }

bot.onText(/\/start/, (msg) => {
  const chatId = msg.chat.id;
  userFiles[chatId] = [];
  const opts = {
    reply_markup: {
      keyboard: [
        [{ text: 'Объединить промокоды' }],
      ],
      resize_keyboard: true,
      one_time_keyboard: true
    }
  };
  bot.sendMessage(chatId, 'Привет! Нажми кнопку "Объединить промокоды", чтобы отправить CSV-файлы для объединения.', opts);
});

bot.on('message', async (msg) => {
  const chatId = msg.chat.id;

  if (msg.text === 'Объединить промокоды') {
    userFiles[chatId] = [];
    return bot.sendMessage(chatId, 'Отправь CSV-файлы (можно несколько), а когда закончишь, нажми кнопку "Завершить объединение".', {
      reply_markup: {
        keyboard: [
          [{ text: 'Завершить объединение' }],
        ],
        resize_keyboard: true,
        one_time_keyboard: true
      }
    });
  }

  if (msg.text === 'Завершить объединение') {
    if (!userFiles[chatId] || userFiles[chatId].length === 0) {
      return bot.sendMessage(chatId, 'Ты не отправил ни одного файла.');
    }

    try {
      bot.sendMessage(chatId, 'Начинаю объединение файлов...');

      // Сгруппируем файлы по префиксу (без (1), (2) и расширения)
      function getPrefix(filename) {
        let name = filename.replace(/\.csv$/i, '');
        name = name.replace(/\s*\(\d+\)$/, '');
        return name;
      }

      const groups = {};
      userFiles[chatId].forEach(({ filePath, originalName }) => {
        const prefix = getPrefix(originalName);
        if (!groups[prefix]) groups[prefix] = [];
        groups[prefix].push(filePath);
      });

      const resultFiles = [];

      for (const [prefix, files] of Object.entries(groups)) {
        let mergedContent = '';
        let isFirstFile = true;

        files.forEach(filePath => {
          const content = fs.readFileSync(filePath, 'utf8').trim();
          const lines = content.split('\n');
          if (lines.length === 0) return;

          const header = lines[0];
          const dataRows = lines.slice(1);

          if (isFirstFile) {
            mergedContent += header + '\n';
            isFirstFile = false;
          }

          dataRows.forEach(line => {
            if (line.trim()) {
              mergedContent += line + '\n';
            }
          });
        });

        const outputFilePath = path.join(OUTPUT_DIR, `${prefix}.csv`);
        fs.writeFileSync(outputFilePath, mergedContent, 'utf8');
        resultFiles.push(outputFilePath);
      }

      // Отправляем объединённые файлы пользователю
      for (const filePath of resultFiles) {
        await bot.sendDocument(chatId, filePath);
      }

      bot.sendMessage(chatId, 'Готово! Файлы объединены и отправлены.');

      // Очистка временных файлов
      userFiles[chatId].forEach(({ filePath }) => {
        if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
      });
      userFiles[chatId] = [];

      // Также можно почистить outputDir при желании, если нужно
    } catch (err) {
      console.error(err);
      bot.sendMessage(chatId, 'Произошла ошибка при объединении файлов.');
    }

    return;
  }

  // Если пришёл документ, и мы ожидаем файлы для объединения
  if (msg.document && userFiles[chatId] !== undefined) {
    const fileId = msg.document.file_id;
    const fileName = msg.document.file_name;

    if (!fileName.endsWith('.csv')) {
      return bot.sendMessage(chatId, 'Пожалуйста, отправляй только CSV-файлы.');
    }

    try {
      const fileLink = await bot.getFileLink(fileId);
      const res = await fetch(fileLink);
      const buffer = await res.arrayBuffer();
      const tempFilePath = path.join(TEMP_DIR, `${chatId}-${Date.now()}-${fileName}`);
      fs.writeFileSync(tempFilePath, Buffer.from(buffer));
      userFiles[chatId].push({ filePath: tempFilePath, originalName: fileName });

      bot.sendMessage(chatId, `Файл ${fileName} сохранён. Можешь отправить ещё или нажать "Завершить объединение".`);
    } catch (err) {
      console.error(err);
      bot.sendMessage(chatId, 'Ошибка при загрузке файла.');
    }
  }
});
