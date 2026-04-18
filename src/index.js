/**
 * Portfolio Manager — Cloudflare Worker
 *
 * Chức năng:
 *  - Cron mỗi giờ: lấy giá crypto từ CoinGecko, tỷ giá từ exchangerate-api
 *    rồi ghi vào Google Sheets qua Sheets API
 *  - Kiểm tra ngưỡng phân bổ, gửi cảnh báo Telegram khi vượt
 *  - Webhook nhận lệnh Telegram Bot (/portfolio /alerts /sync /top)
 *
 * Biến môi trường (cài trong Cloudflare Dashboard → Workers → Settings → Variables):
 *  GOOGLE_SERVICE_ACCOUNT_KEY  — JSON của Google Service Account (base64)
 *  SPREADSHEET_ID              — ID của Google Sheet (lấy từ URL)
 *  COINGECKO_API_KEY           — Demo API key từ coingecko.com/api (để trống cũng được)
 *  TELEGRAM_BOT_TOKEN          — Token từ @BotFather
 *  TELEGRAM_CHAT_ID            — Chat ID của bạn
 */

// ── Tên sheet (phải khớp với Google Sheets) ─────────────────
const SHEET = {
  ASSETS:        'ASSETS',
  ALLOCATION:    'ALLOCATION',
  CONFIG:        'CONFIG',
  PRICE_HISTORY: 'PRICE_HISTORY',
  ALERT_LOG:     'ALERT_LOG',
};

// ── Cột trong ASSETS (A=1, B=2...) ──────────────────────────
const COL = {
  TICKER:        3,   // C
  GROUP:         4,   // D
  SOURCE:        5,   // E
  CURRENCY:      7,   // G
  STATUS:        8,   // H
  QTY:           9,   // I
  CURRENT_PRICE: 11,  // K
  FX_RATE:       13,  // M
};

const DATA_START_ROW = 5;

// ── Mapping ticker → CoinGecko coin ID ──────────────────────
const CG_ID = {
  BTC: 'bitcoin',     ETH: 'ethereum',    BNB: 'binancecoin',
  SOL: 'solana',      ADA: 'cardano',     XRP: 'ripple',
  DOGE:'dogecoin',    DOT: 'polkadot',    AVAX:'avalanche-2',
  MATIC:'matic-network', LINK:'chainlink', UNI:'uniswap',
  ATOM:'cosmos',      LTC: 'litecoin',    TON: 'the-open-network',
  NEAR:'near',        ARB: 'arbitrum',    OP:  'optimism',
  SUI: 'sui',         TRX: 'tron',        WBT: 'whitebit',
};

// ════════════════════════════════════════════════════════════
//  ENTRY POINT
// ════════════════════════════════════════════════════════════
export default {

  // Cron trigger (mỗi giờ)
  async scheduled(event, env, ctx) {
    ctx.waitUntil(runHourly(env));
  },

  // HTTP requests (Telegram webhook + health check)
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    // Health check
    if (url.pathname === '/health') {
      return new Response(JSON.stringify({ status: 'ok', ts: Date.now() }), {
        headers: { 'Content-Type': 'application/json' },
      });
    }

    // Telegram webhook
    if (url.pathname === '/webhook' && request.method === 'POST') {
      ctx.waitUntil(handleTelegramWebhook(request, env));
      return new Response('ok');
    }

    // Trigger manual sync (bảo vệ bằng secret header)
    if (url.pathname === '/sync' && request.method === 'POST') {
      const auth = request.headers.get('X-Sync-Secret');
      if (auth !== env.SYNC_SECRET) {
        return new Response('Unauthorized', { status: 401 });
      }
      ctx.waitUntil(runHourly(env));
      return new Response(JSON.stringify({ status: 'sync started' }), {
        headers: { 'Content-Type': 'application/json' },
      });
    }

    // Setup webhook (gọi 1 lần sau deploy)
    if (url.pathname === '/setup-webhook' && request.method === 'POST') {
      const workerUrl = `${url.origin}/webhook`;
      const result = await setupTelegramWebhook(env, workerUrl);
      return new Response(JSON.stringify(result), {
        headers: { 'Content-Type': 'application/json' },
      });
    }

    return new Response('Portfolio Worker — OK', { status: 200 });
  },
};

// ════════════════════════════════════════════════════════════
//  LOGIC CHÍNH: chạy mỗi giờ
// ════════════════════════════════════════════════════════════
async function runHourly(env) {
  console.log('[runHourly] bắt đầu', new Date().toISOString());
  try {
    await syncPrices(env);
    await checkThresholdsAndAlert(env);
  } catch (e) {
    console.error('[runHourly] lỗi:', e.message);
  }
}

// ════════════════════════════════════════════════════════════
//  SYNC GIÁ
// ════════════════════════════════════════════════════════════
async function syncPrices(env) {
  const sheets = new GoogleSheets(env);

  // Đọc danh sách tài sản
  const assetsData = await sheets.getRange(`${SHEET.ASSETS}!A${DATA_START_ROW}:N200`);
  if (!assetsData?.values?.length) {
    console.log('[syncPrices] không có tài sản nào');
    return;
  }

  const rows = assetsData.values;

  // Lấy tỷ giá một lần
  const [usdVnd, eurVnd] = await Promise.all([getFxRate('USD'), getFxRate('EUR')]);
  console.log(`[syncPrices] tỷ giá USD/VND: ${usdVnd}, EUR/VND: ${eurVnd}`);

  // Thu thập tickers crypto cần lấy giá
  const cryptoTickers = [];
  rows.forEach(row => {
    const status = row[COL.STATUS - 1] || '';
    const source = row[COL.SOURCE - 1] || '';
    const ticker = (row[COL.TICKER - 1] || '').toUpperCase();
    if (status === 'ACTIVE' && ['BINANCE', 'COINGECKO'].includes(source) && CG_ID[ticker]) {
      cryptoTickers.push(ticker);
    }
  });

  // Lấy giá batch từ CoinGecko (1 request cho tất cả)
  const cryptoPrices = cryptoTickers.length > 0
    ? await getCoinGeckoPrices([...new Set(cryptoTickers)], env)
    : {};

  // Chuẩn bị batch update cho Sheets
  const batchUpdates = [];
  const historyRows = [];
  const now = new Date().toISOString();

  rows.forEach((row, i) => {
    const rowNum = DATA_START_ROW + i;
    const status   = row[COL.STATUS - 1] || '';
    const source   = row[COL.SOURCE - 1] || '';
    const ticker   = (row[COL.TICKER - 1] || '').toUpperCase();
    const currency = row[COL.CURRENCY - 1] || 'VND';
    const qty      = parseFloat(row[COL.QTY - 1]) || 0;

    if (status !== 'ACTIVE') return;

    let newPrice = null;
    const fxRate = currency === 'USD' ? usdVnd : currency === 'EUR' ? eurVnd : 1;

    if (['BINANCE', 'COINGECKO'].includes(source)) {
      newPrice = cryptoPrices[ticker] ?? null;
    }
    // GOOGLEFINANCE và MANUAL: giá tự cập nhật trong Sheets hoặc nhập tay

    // Ghi giá mới
    if (newPrice !== null) {
      batchUpdates.push({
        range: `${SHEET.ASSETS}!K${rowNum}`,
        values: [[newPrice]],
      });
    }

    // Luôn cập nhật tỷ giá cho tài sản ngoại tệ
    if (currency !== 'VND') {
      batchUpdates.push({
        range: `${SHEET.ASSETS}!M${rowNum}`,
        values: [[fxRate]],
      });
    }

    // Ghi lịch sử
    const price = newPrice ?? parseFloat(row[COL.CURRENT_PRICE - 1]) || 0;
    if (price > 0 && qty > 0) {
      historyRows.push([now, ticker, row[1] || '', row[COL.GROUP - 1] || '',
        price, currency, fxRate, qty * price * fxRate]);
    }
  });

  // Batch write vào Sheets
  if (batchUpdates.length > 0) {
    await sheets.batchUpdate(batchUpdates);
    console.log(`[syncPrices] cập nhật ${batchUpdates.length} ô`);
  }

  // Ghi lịch sử giá
  if (historyRows.length > 0) {
    await sheets.appendRows(`${SHEET.PRICE_HISTORY}!A:H`, historyRows);
  }

  // Cập nhật thời gian sync trong CONFIG
  await sheets.batchUpdate([{
    range: `${SHEET.CONFIG}!B2`,
    values: [[now]],
  }]);
}

// ════════════════════════════════════════════════════════════
//  KIỂM TRA NGƯỠNG & GỬI CẢNH BÁO
// ════════════════════════════════════════════════════════════
async function checkThresholdsAndAlert(env) {
  const sheets = new GoogleSheets(env);
  const data = await sheets.getRange(`${SHEET.ALLOCATION}!A4:I20`);
  if (!data?.values?.length) return;

  const violations = [];
  const warnings = [];

  data.values.forEach(row => {
    if (!row[0]) return;
    const group     = row[0];
    const actual    = parseFloat(row[2]) || 0;
    const threshold = parseFloat(row[3]) || 0;
    const diff      = actual - threshold;
    const toSell    = parseFloat(row[6]) || 0;
    const status    = row[8] || '';

    if (threshold === 0) return;

    if (status.includes('VƯỢT')) {
      violations.push({ group, actual, threshold, diff, toSell });
    } else if (status.includes('GẦN')) {
      warnings.push({ group, actual, threshold, diff });
    }
  });

  if (violations.length > 0 || warnings.length > 0) {
    await sendTelegramAlert(env, violations, warnings);
    await logAlerts(sheets, violations, warnings);
  }

  console.log(`[checkThresholds] ${violations.length} vi phạm, ${warnings.length} cảnh báo`);
}

// ════════════════════════════════════════════════════════════
//  TELEGRAM BOT — nhận lệnh
// ════════════════════════════════════════════════════════════
async function handleTelegramWebhook(request, env) {
  let update;
  try {
    update = await request.json();
  } catch {
    return;
  }

  const msg = update.message || update.edited_message;
  if (!msg) return;

  const chatId  = String(msg.chat.id);
  const text    = (msg.text || '').toLowerCase().trim();

  // Kiểm tra quyền — chỉ chấp nhận đúng chat ID đã cấu hình
  if (chatId !== env.TELEGRAM_CHAT_ID) {
    await sendTelegramMessage(env, chatId, 'Không có quyền truy cập\\.');
    return;
  }

  const sheets = new GoogleSheets(env);

  switch (true) {
    case text === '/start' || text === '/help':
      await sendTelegramMessage(env, chatId,
        '*Portfolio Bot*\n\n' +
        '/portfolio \\- Tổng quan danh mục\n' +
        '/alerts \\- Kiểm tra cảnh báo\n' +
        '/sync \\- Đồng bộ giá ngay\n' +
        '/top \\- Top 5 tài sản\n' +
        '/help \\- Menu này'
      );
      break;

    case text === '/portfolio':
      await sendTelegramMessage(env, chatId, await buildPortfolioSummary(sheets));
      break;

    case text === '/alerts':
      await checkThresholdsAndAlert(env);
      break;

    case text === '/sync':
      await sendTelegramMessage(env, chatId, '🔄 Đang đồng bộ giá\\.\\.\\.');
      await syncPrices(env);
      await sendTelegramMessage(env, chatId, '✅ Đồng bộ hoàn tất\\!');
      break;

    case text === '/top':
      await sendTelegramMessage(env, chatId, await buildTopAssets(sheets, 5));
      break;

    default:
      await sendTelegramMessage(env, chatId,
        'Lệnh không hợp lệ\\. Gõ /help để xem danh sách\\.'
      );
  }
}

// ════════════════════════════════════════════════════════════
//  XÂY NỘI DUNG TELEGRAM
// ════════════════════════════════════════════════════════════
async function buildPortfolioSummary(sheets) {
  const data = await sheets.getRange(`${SHEET.ALLOCATION}!A4:I20`);
  if (!data?.values?.length) return 'Chưa có dữ liệu\\.';

  let totalVnd = 0;
  data.values.forEach(r => { totalVnd += parseFloat(r[1]) || 0; });

  let msg = `*📊 Tổng quan danh mục*\n💰 *${fmtVND(totalVnd)}*\n\n`;
  data.values.forEach(r => {
    if (!r[0]) return;
    const pct    = ((parseFloat(r[2]) || 0) * 100).toFixed(1);
    const status = r[8] || '';
    const icon   = status.includes('VƯỢT') ? '⚠️' : status.includes('GẦN') ? '🟡' : '✅';
    msg += `${icon} ${escMd(r[0])}: ${pct}%\n`;
  });
  msg += `\n_${fmtTime(new Date())}_`;
  return msg;
}

async function buildTopAssets(sheets, n) {
  const data = await sheets.getRange(`${SHEET.ASSETS}!B${DATA_START_ROW}:N200`);
  if (!data?.values?.length) return 'Chưa có dữ liệu\\.';

  const active = data.values
    .filter(r => r[6] === 'ACTIVE')
    .map(r => ({ name: r[0], value: parseFloat(r[12]) || 0 }))
    .filter(r => r.value > 0)
    .sort((a, b) => b.value - a.value)
    .slice(0, n);

  let msg = `*🏆 Top ${n} tài sản*\n\n`;
  active.forEach((a, i) => {
    msg += `${i + 1}\\. *${escMd(a.name)}*: ${fmtVND(a.value)}\n`;
  });
  return msg;
}

async function sendTelegramAlert(env, violations, warnings) {
  let msg = '*📊 Portfolio Alert*\n';
  msg += `_${escMd(fmtTime(new Date()))}_\n\n`;

  if (violations.length > 0) {
    msg += '*⚠️ VƯỢT NGƯỠNG — cần tái cơ cấu:*\n';
    violations.forEach(v => {
      msg += `• *${escMd(v.group)}*: ${(v.actual*100).toFixed(1)}% / ${(v.threshold*100).toFixed(1)}%`;
      msg += ` \\(\\+${(v.diff*100).toFixed(1)}%\\) → bán ≈ ${fmtVND(v.toSell)}\n`;
    });
    msg += '\n';
  }

  if (warnings.length > 0) {
    msg += '*🟡 GẦN NGƯỠNG — theo dõi sát:*\n';
    warnings.forEach(w => {
      msg += `• *${escMd(w.group)}*: ${(w.actual*100).toFixed(1)}% / ${(w.threshold*100).toFixed(1)}%\n`;
    });
  }

  msg += '\n_/portfolio để xem chi tiết_';
  await sendTelegramMessage(env, env.TELEGRAM_CHAT_ID, msg);
}

// ════════════════════════════════════════════════════════════
//  API: COINGECKO
// ════════════════════════════════════════════════════════════
async function getCoinGeckoPrices(tickers, env) {
  const ids = tickers.map(t => CG_ID[t]).filter(Boolean).join(',');
  if (!ids) return {};

  const apiKey = env.COINGECKO_API_KEY || '';
  const url = `https://api.coingecko.com/api/v3/simple/price?ids=${ids}&vs_currencies=usd`
    + (apiKey ? `&x_cg_demo_api_key=${apiKey}` : '');

  try {
    const res = await fetch(url, {
      headers: { 'Accept': 'application/json' },
      cf: { cacheTtl: 60, cacheEverything: true },  // cache 60s trên Cloudflare edge
    });

    if (res.status === 429) {
      console.warn('[CoinGecko] rate limited — skip lần này');
      return {};
    }
    if (!res.ok) {
      console.error('[CoinGecko] lỗi HTTP', res.status);
      return {};
    }

    const data = await res.json();

    // Đảo ngược map: coin_id → ticker
    const idToTicker = {};
    Object.entries(CG_ID).forEach(([t, id]) => { idToTicker[id] = t; });

    const prices = {};
    Object.entries(data).forEach(([id, val]) => {
      const t = idToTicker[id];
      if (t && val?.usd) prices[t] = val.usd;
    });

    console.log(`[CoinGecko] giá ${Object.keys(prices).length} coin: ${Object.keys(prices).join(', ')}`);
    return prices;
  } catch (e) {
    console.error('[CoinGecko] lỗi:', e.message);
    return {};
  }
}

// ════════════════════════════════════════════════════════════
//  API: TỶ GIÁ (open.er-api.com — miễn phí, không cần key)
// ════════════════════════════════════════════════════════════
async function getFxRate(baseCurrency) {
  const FALLBACK = { USD: 25400, EUR: 27800 };
  try {
    const res = await fetch(
      `https://open.er-api.com/v6/latest/${baseCurrency}`,
      { cf: { cacheTtl: 3600, cacheEverything: true } }  // cache 1 tiếng
    );
    if (!res.ok) return FALLBACK[baseCurrency] ?? 1;
    const data = await res.json();
    return data?.rates?.VND ?? FALLBACK[baseCurrency] ?? 1;
  } catch {
    return FALLBACK[baseCurrency] ?? 1;
  }
}

// ════════════════════════════════════════════════════════════
//  API: TELEGRAM
// ════════════════════════════════════════════════════════════
async function sendTelegramMessage(env, chatId, text) {
  const token = env.TELEGRAM_BOT_TOKEN;
  if (!token) return;

  const res = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chat_id: chatId, text, parse_mode: 'MarkdownV2' }),
  });

  if (!res.ok) {
    const err = await res.text();
    console.error('[Telegram] lỗi gửi:', err);
  }
}

async function setupTelegramWebhook(env, workerUrl) {
  const token = env.TELEGRAM_BOT_TOKEN;
  if (!token) return { error: 'TELEGRAM_BOT_TOKEN chưa cấu hình' };
  const res = await fetch(
    `https://api.telegram.org/bot${token}/setWebhook?url=${workerUrl}`
  );
  return res.json();
}

// ════════════════════════════════════════════════════════════
//  GOOGLE SHEETS API
// ════════════════════════════════════════════════════════════
class GoogleSheets {
  constructor(env) {
    this.spreadsheetId = env.SPREADSHEET_ID;
    this.env = env;
    this._token = null;
    this._tokenExpiry = 0;
  }

  async getAccessToken() {
    // Token còn hạn (buffer 5 phút)
    if (this._token && Date.now() < this._tokenExpiry - 300_000) {
      return this._token;
    }

    // Decode Service Account JSON từ env (base64)
    const saJson = JSON.parse(atob(this.env.GOOGLE_SERVICE_ACCOUNT_KEY));

    // Tạo JWT để lấy access token
    const now = Math.floor(Date.now() / 1000);
    const claim = {
      iss: saJson.client_email,
      scope: 'https://www.googleapis.com/auth/spreadsheets',
      aud: 'https://oauth2.googleapis.com/token',
      exp: now + 3600,
      iat: now,
    };

    const jwt = await makeJwt(claim, saJson.private_key);

    const res = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: `grant_type=urn:ietf:params:oauth:grant-type:jwt-bearer&assertion=${jwt}`,
    });

    const data = await res.json();
    if (!data.access_token) {
      throw new Error('Google OAuth lỗi: ' + JSON.stringify(data));
    }

    this._token = data.access_token;
    this._tokenExpiry = Date.now() + (data.expires_in * 1000);
    return this._token;
  }

  async getRange(range) {
    const token = await this.getAccessToken();
    const url = `https://sheets.googleapis.com/v4/spreadsheets/${this.spreadsheetId}`
      + `/values/${encodeURIComponent(range)}`;
    const res = await fetch(url, {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!res.ok) throw new Error(`Sheets getRange lỗi: ${res.status} ${await res.text()}`);
    return res.json();
  }

  async batchUpdate(data) {
    const token = await this.getAccessToken();
    const url = `https://sheets.googleapis.com/v4/spreadsheets/${this.spreadsheetId}`
      + `/values:batchUpdate`;
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        valueInputOption: 'USER_ENTERED',
        data: data.map(d => ({ range: d.range, values: d.values })),
      }),
    });
    if (!res.ok) throw new Error(`Sheets batchUpdate lỗi: ${res.status} ${await res.text()}`);
    return res.json();
  }

  async appendRows(range, rows) {
    const token = await this.getAccessToken();
    const url = `https://sheets.googleapis.com/v4/spreadsheets/${this.spreadsheetId}`
      + `/values/${encodeURIComponent(range)}:append?valueInputOption=USER_ENTERED&insertDataOption=INSERT_ROWS`;
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ values: rows }),
    });
    if (!res.ok) throw new Error(`Sheets appendRows lỗi: ${res.status} ${await res.text()}`);
    return res.json();
  }
}

// ════════════════════════════════════════════════════════════
//  GHI LOG CẢNH BÁO
// ════════════════════════════════════════════════════════════
async function logAlerts(sheets, violations, warnings) {
  const now = new Date().toISOString();
  const rows = [
    ...violations.map(v => [now, v.group, v.actual, v.threshold, v.diff, '⚠️ VƯỢT NGƯỠNG', 'Đã gửi', '']),
    ...warnings.map(w =>   [now, w.group, w.actual, w.threshold, w.diff, '🟡 GẦN NGƯỠNG',  'Đã gửi', '']),
  ];
  if (rows.length > 0) {
    await sheets.appendRows(`${SHEET.ALERT_LOG}!A:H`, rows);
  }
}

// ════════════════════════════════════════════════════════════
//  JWT HELPER — dùng Web Crypto API có sẵn trong Workers
// ════════════════════════════════════════════════════════════
async function makeJwt(payload, pemKey) {
  const header = { alg: 'RS256', typ: 'JWT' };
  const encode = obj => btoa(JSON.stringify(obj))
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '');

  const unsigned = `${encode(header)}.${encode(payload)}`;

  // Import PEM private key
  const pem = pemKey
    .replace(/-----BEGIN PRIVATE KEY-----/, '')
    .replace(/-----END PRIVATE KEY-----/, '')
    .replace(/\s/g, '');
  const der = Uint8Array.from(atob(pem), c => c.charCodeAt(0));

  const key = await crypto.subtle.importKey(
    'pkcs8', der.buffer,
    { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
    false, ['sign']
  );

  const sig = await crypto.subtle.sign(
    'RSASSA-PKCS1-v1_5', key,
    new TextEncoder().encode(unsigned)
  );

  const sigB64 = btoa(String.fromCharCode(...new Uint8Array(sig)))
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '');

  return `${unsigned}.${sigB64}`;
}

// ════════════════════════════════════════════════════════════
//  TIỆN ÍCH
// ════════════════════════════════════════════════════════════
function fmtVND(n) {
  if (!n || isNaN(n)) return '0 ₫';
  if (n >= 1e9) return `${(n/1e9).toFixed(2)} tỷ ₫`;
  if (n >= 1e6) return `${Math.round(n/1e6)} triệu ₫`;
  return `${Math.round(n).toLocaleString('vi-VN')} ₫`;
}

function fmtTime(date) {
  return date.toLocaleString('vi-VN', { timeZone: 'Asia/Ho_Chi_Minh' });
}

function escMd(text) {
  return String(text).replace(/([_*[\]()~`>#+\-=|{}.!\\])/g, '\\$1');
}
