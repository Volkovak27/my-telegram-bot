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

// ────────────────────────── Папки ──────────────────────────
const RETENTION_DIR = path.join(__dirname, 'retention');
const TEMP_DIR      = path.join(__dirname, 'temp_files');
const OUTPUT_DIR    = path.join(__dirname, 'outputs');

[RETENTION_DIR, TEMP_DIR, OUTPUT_DIR].forEach(dir => {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
});

// ─────────────────────── Cписки кодов ──────────────────────
const SOE_CODES = [
  'AZN','BDT','BRL','CLP','COP','CZK','EGP','EUR','HUF','INR',
  'KGS','KZT','LKP','MAD','MXN','NPR','PEN','PKR','PLN','RUB',
  'TND','TRY','USD','UZS'
];
const EC_CODES  = ['UAH','BYN','CAD','SEK','VND'];

// ───────────────────── Ф-ция имени файла ───────────────────
const getFilename = (size, codeList) => {
  const uniqueCodes = [...new Set(codeList)];
  const hasECCode  = uniqueCodes.some(code => EC_CODES.includes(code));
  const hasSOECode = uniqueCodes.some(code => SOE_CODES.includes(code));

  let gameName = 'Unknown_Game';
  if (hasECCode && !hasSOECode) gameName = 'MB_Energy_Coins_Hold_and_Win';
  else                           gameName = 'MB_Sun_of_Egypt_3';

  return `Birthday_freespins_${gameName}_v${size}_crm.csv`;
};

// ──────────────────────── Состояния ────────────────────────
const userFiles     = {};   // временное хранилище CSV при объединении
const awaitingPromo = {};   // ждём файл для «Разделить на промокоды»

// ───────────────────────── /start ──────────────────────────
bot.onText(/\/start/, msg => {
  const chatId = msg.chat.id;
  userFiles[chatId] = [];

  bot.sendMessage(chatId, 'Привет! Выберите действие:', {
    reply_markup: {
      keyboard: [
        [{ text: '🎰 Разделить на фриспины' }],
        [{ text: '📦 Разделить на промокоды' }],
        [{ text: '🧩 Объединить файлы' }]
      ],
      resize_keyboard: true
    }
  });
});

// ─────────────────── Обработка текст-сообщений ─────────────
bot.on('message', async msg => {
  const chatId = msg.chat.id;

  // --- Разделить на фриспины --------------------------------
  if (msg.text === '🎰 Разделить на фриспины') {
    return bot.sendMessage(chatId, 'Отправь Excel-файл (.xlsx), я разделю его по размеру фриспинов.');
  }

  // --- Разделить на промокоды -------------------------------
  if (msg.text === '📦 Разделить на промокоды') {
    awaitingPromo[chatId] = true;
    return bot.sendMessage(chatId, 'Отправь Excel-файл (.xlsx), я разделю его по промогруппам.');
  }

  // --- Объединить файлы -------------------------------------
  if (msg.text === '🧩 Объединить файлы') {
    userFiles[chatId] = [];
    return bot.sendMessage(chatId, 'Отправь CSV-файлы. Когда закончишь — нажми «Завершить объединение».', {
      reply_markup: {
        keyboard: [[{ text: 'Завершить объединение' }]],
        resize_keyboard: true
      }
    });
  }

  // --- Завершить объединение --------------------------------
  if (msg.text === 'Завершить объединение') {
    if (!userFiles[chatId] || userFiles[chatId].length === 0) {
      return bot.sendMessage(chatId, 'Ты не отправил ни одного файла.');
    }

    // группируем по имени (до расширения и возможного суффикса (1), (2) …)
    const groups = {};
    for (const { filePath, originalName } of userFiles[chatId]) {
      const prefix = originalName.replace(/\.csv$/i, '').replace(/\s*\(\d+\)$/, '');
      if (!groups[prefix]) groups[prefix] = [];
      groups[prefix].push(filePath);
    }

    // объединяем по группам
    const resultFiles = [];
    for (const [prefix, files] of Object.entries(groups)) {
      let merged = '';
      let isFirst = true;

      files.forEach(filePath => {
        const lines = fs.readFileSync(filePath, 'utf8').trim().split('\n');
        if (!lines.length) return;
        const [header, ...rows] = lines;
        if (isFirst) {
          merged += header + '\n';
          isFirst = false;
        }
        merged += rows.join('\n') + '\n';
      });

      const outPath = path.join(OUTPUT_DIR, `${prefix}.csv`);
      fs.writeFileSync(outPath, merged);
      resultFiles.push(outPath);
    }

    // отправляем готовые файлы
    for (const file of resultFiles) {
      await bot.sendDocument(chatId, file);
    }
    bot.sendMessage(chatId, 'Готово ✅');

    // возвращаем главное меню
    bot.sendMessage(chatId, 'Выбери следующее действие:', {
      reply_markup: {
        keyboard: [
          [{ text: '🎰 Разделить на фриспины' }],
          [{ text: '📦 Разделить на промокоды' }],
          [{ text: '🧩 Объединить файлы' }]
        ],
        resize_keyboard: true
      }
    });

    // чистим временные файлы
    userFiles[chatId].forEach(({ filePath }) => {
      if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
    });
    userFiles[chatId] = [];
  }
});

// ─────────────────── Обработка документов ──────────────────
bot.on('document', async msg => {
  const chatId = msg.chat.id;
  const { file_id, file_name } = msg.document;

  const fileLink = await bot.getFileLink(file_id);

  // ------------ «Разделить на промокоды» --------------------
  if (awaitingPromo[chatId]) {
    awaitingPromo[chatId] = false;

    if (!file_name.endsWith('.xlsx')) {
      return bot.sendMessage(chatId, 'Формат файла должен быть .xlsx');
    }

    const res     = await fetch(fileLink);
    const buffer  = Buffer.from(await res.arrayBuffer());
    const tempPath = path.join(__dirname, `temp_${chatId}.xlsx`);
    fs.writeFileSync(tempPath, buffer);

    const wb      = XLSX.readFile(tempPath);
    let allData   = [];

    wb.SheetNames.forEach(sheet => {
      const data    = XLSX.utils.sheet_to_json(wb.Sheets[sheet], { header: 1 });
      const headers = data[0];
      if (!headers) return;

      const userIdIdx = headers.findIndex(h => h === 'user_id');
      const promoIdx  = headers.findIndex(h => h?.toLowerCase().includes('promo'));
      if (userIdIdx === -1 || promoIdx === -1) return;

      for (let i = 1; i < data.length; i++) {
        const row = data[i];
        if (row[userIdIdx] && row[promoIdx]) {
          allData.push({ user_id: row[userIdIdx], group: row[promoIdx] });
        }
      }
    });

    // группируем и сохраняем CSV
    const grouped = {};
    allData.forEach(r => {
      if (!grouped[r.group]) grouped[r.group] = [];
      grouped[r.group].push(r);
    });

    for (const [group, rows] of Object.entries(grouped)) {
      const safeName = String(group).replace(/[^a-zA-Z0-9_-]/g, '_');
      const csv      = XLSX.utils.sheet_to_csv(
        XLSX.utils.json_to_sheet(rows.map(r => ({ user_id: r.user_id })))
      );
      const outPath  = path.join(OUTPUT_DIR, `${safeName}.csv`);
      fs.writeFileSync(outPath, csv);
      await bot.sendDocument(chatId, outPath);
    }

    fs.unlinkSync(tempPath);
    return bot.sendMessage(chatId, 'Готово ✅');
  }

  // ------------ «Разделить на фриспины» ---------------------
  if (file_name.endsWith('.xlsx')) {
    const res     = await fetch(fileLink);
    const buffer  = Buffer.from(await res.arrayBuffer());
    const filePath = path.join(RETENTION_DIR, file_name);
    fs.writeFileSync(filePath, buffer);

    const wb      = XLSX.readFile(filePath);
    let allData   = [];

    wb.SheetNames.forEach(sheet => {
      const data = XLSX.utils.sheet_to_json(wb.Sheets[sheet]);
      allData    = allData.concat(data.map(r => ({ ...r, user_id: r.user_id ?? null })));
    });

    // группируем по размеру фриспинов
    const grouped = {};
    allData.forEach(row => {
      const size = row['Freespin_size'] ?? row['FS'] ?? 'undefined';
      if (!grouped[size]) grouped[size] = [];
      grouped[size].push(row);
    });

    for (const [size, rows] of Object.entries(grouped)) {
      const seen   = new Set();
      const unique = [];
      const codes  = [];

      rows.forEach(r => {
        if (!seen.has(r.user_id)) {
          seen.add(r.user_id);
          unique.push(r);
          if (r.code) codes.push(String(r.code).trim());
        }
      });

      const csv     = XLSX.utils.sheet_to_csv(
        XLSX.utils.json_to_sheet(unique.map(r => ({ user_id: r.user_id })))
      );
      const outPath = path.join(OUTPUT_DIR, getFilename(size, codes));
      fs.writeFileSync(outPath, csv);
      await bot.sendDocument(chatId, outPath);
    }

    return bot.sendMessage(chatId, 'Готово ✅');
  }

  // ------------ «Объединить файлы» (приём CSV) --------------
  if (file_name.endsWith('.csv')) {
    const res      = await fetch(fileLink);
    const buffer   = Buffer.from(await res.arrayBuffer());
    const filePath = path.join(TEMP_DIR, `${Date.now()}_${file_name}`);
    fs.writeFileSync(filePath, buffer);

    if (!userFiles[chatId]) userFiles[chatId] = [];
    userFiles[chatId].push({ filePath, originalName: file_name });

    return bot.sendMessage(chatId, 'Файл получен, жду другие или нажми «Завершить объединение».');
  }
});
