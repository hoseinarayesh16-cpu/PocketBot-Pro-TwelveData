
import express from 'express';

const app = express();
app.disable('x-powered-by');
app.use(express.static('public'));

const symbols = {
  EURUSD: 'EUR/USD',
  GBPUSD: 'GBP/USD',
  USDJPY: 'USD/JPY',
  USDCHF: 'USD/CHF',
  AUDUSD: 'AUD/USD',
  USDCAD: 'USD/CAD',
  NZDUSD: 'NZD/USD',
  EURGBP: 'EUR/GBP',
  EURJPY: 'EUR/JPY',
  GBPJPY: 'GBP/JPY',
  XAUUSD: 'XAU/USD'
};

const intervals = {
  m1: '1min',
  m5: '5min',
  m15: '15min',
  m30: '30min',
  h1: '1h',
  h4: '4h',
  d1: '1day',
  w1: '1week'
};

const minutes = {
  m1: 1,
  m5: 5,
  m15: 15,
  m30: 30,
  h1: 60,
  h4: 240,
  d1: 1440,
  w1: 10080
};

const cache = new Map();

app.get('/health', (_, res) => {
  res.json({
    ok: true,
    version: '2.1',
    source: 'Twelve Data',
    configured: Boolean(process.env.TWELVE_DATA_API_KEY)
  });
});

app.get('/api/candles', async (req, res) => {
  const symbol = String(req.query.symbol || 'EURUSD').toUpperCase();
  const tf = String(req.query.tf || 'm5').toLowerCase();

  if (!symbols[symbol] || !intervals[tf]) {
    return res.status(400).json({
      error: 'نماد یا تایم‌فریم نامعتبر است'
    });
  }

  const apiKey = process.env.TWELVE_DATA_API_KEY;

  if (!apiKey) {
    return res.status(503).json({
      error: 'کلید API روی سرور تنظیم نشده است'
    });
  }

  const cacheKey = `${symbol}:${tf}`;
  const old = cache.get(cacheKey);

  if (old && Date.now() - old.at < 60000) {
    return res.json({
      ...old.data,
      cached: true
    });
  }

  try {
    const url = new URL(
      'https://api.twelvedata.com/time_series'
    );

    url.search = new URLSearchParams({
      symbol: symbols[symbol],
      interval: intervals[tf],
      outputsize: '200',
      timezone: 'UTC',
      apikey: apiKey,
      format: 'JSON'
    }).toString();

    const response = await fetch(url, {
      signal: AbortSignal.timeout(18000)
    });

    const body = await response.json();

    if (
      !response.ok ||
      body.status === 'error' ||
      !Array.isArray(body.values)
    ) {
      throw new Error(
        body.message || 'داده معتبر دریافت نشد'
      );
    }

    const candles = body.values.map(v => ({
      time: v.datetime,
      open: Number(v.open),
      high: Number(v.high),
      low: Number(v.low),
      close: Number(v.close)
    }))
    .filter(v =>
      [v.open, v.high, v.low, v.close]
        .every(Number.isFinite) &&
      v.high >= Math.max(v.open, v.close) &&
      v.low <= Math.min(v.open, v.close)
    )
    .reverse();

    if (candles.length < 55) {
      throw new Error('تعداد کندل کافی نیست');
    }

    const meta = body.meta || {};

    // منطقه زمانی پاسخ را مستقل از درخواست بررسی می‌کنیم.
    const reportedTimezone =
      String(meta.timezone || '').trim();

    const isUTC = value =>
      /^(UTC|Etc\/UTC|GMT|Etc\/GMT|Z)$/i.test(value);

    const timezoneConfirmed = isUTC(reportedTimezone);

    const last = candles.at(-1);

    let candleTimestamp = NaN;

    if (
      timezoneConfirmed &&
      /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(last.time)
    ) {
      candleTimestamp = Date.parse(
        last.time.replace(' ', 'T') + 'Z'
      );
    }

    const ageMinutes = Number.isFinite(candleTimestamp)
      ? (Date.now() - candleTimestamp) / 60000
      : null;

    const intervalMinutes = minutes[tf];

    const maximumAgeMinutes = Math.max(
      intervalMinutes * 3,
      15
    );

    // آخرین کندل ممکن است هنوز باز باشد.
    // بنابراین کندل بسته‌شده قبلی را مبنای تحلیل قرار می‌دهیم.
    const now = Date.now();

    let closedCandles = candles;

    if (timezoneConfirmed) {
      closedCandles = candles.filter(c => {
        const t = Date.parse(
          c.time.replace(' ', 'T') + 'Z'
        );

        return Number.isFinite(t) &&
          t + intervalMinutes * 60000 <= now;
      });
    }

    const lastClosed = closedCandles.at(-1);

    const lastClosedTime =
      timezoneConfirmed && lastClosed
        ? Date.parse(
            lastClosed.time.replace(' ', 'T') + 'Z'
          )
        : NaN;

    const closedAgeMinutes =
      Number.isFinite(lastClosedTime)
        ? (now - lastClosedTime) / 60000
        : null;

    const fresh =
      timezoneConfirmed &&
      closedCandles.length >= 55 &&
      closedAgeMinutes !== null &&
      closedAgeMinutes >= intervalMinutes &&
      closedAgeMinutes <= maximumAgeMinutes;

    const day = new Date().getUTCDay();

    // محافظه‌کارانه: آخر هفته سیگنال صادر نمی‌شود.
    const weekend = day === 0 || day === 6;

    const signalAllowed = fresh && !weekend;

    const result = {
      symbol,
      tf,
      candles: closedCandles.length >= 55
        ? closedCandles
        : candles,
      receivedAt: new Date().toISOString(),
      source: 'Twelve Data',
      freshness: {
        timezoneRequested: 'UTC',
        timezoneReported: reportedTimezone || null,
        timezoneConfirmed,
        lastCandleAgeMinutes: closedAgeMinutes ?? ageMinutes,
        maximumAgeMinutes,
        fresh,
        weekend,
        signalAllowed
      },
      note: 'سیگنال‌ها آزمایشی هستند و قیمت ممکن است با Pocket Option متفاوت باشد'
    };

    cache.set(cacheKey, {
      at: Date.now(),
      data: result
    });

    return res.json(result);

  } catch (error) {
    return res.status(502).json({
      error: String(error.message || error)
    });
  }
});

const PORT = process.env.PORT || 8787;

app.listen(PORT, '0.0.0.0', () => {
  console.log(`PocketBot Pro V2.1 running on port ${PORT}`);
});
