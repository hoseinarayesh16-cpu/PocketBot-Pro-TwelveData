
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
    version: '2.2',
    source: 'Twelve Data',
    configured: Boolean(process.env.TWELVE_DATA_API_KEY)
  });
});

function parseUTC(value) {
  if (!/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(value)) {
    return NaN;
  }
  return Date.parse(value.replace(' ', 'T') + 'Z');
}

function normalizeCandles(values) {
  return values.map(v => ({
    time: v.datetime,
    open: Number(v.open),
    high: Number(v.high),
    low: Number(v.low),
    close: Number(v.close)
  }))
  .filter(v =>
    [v.open, v.high, v.low, v.close].every(Number.isFinite) &&
    v.high >= Math.max(v.open, v.close) &&
    v.low <= Math.min(v.open, v.close)
  )
  .reverse();
}

async function requestSeries(symbol, interval, apiKey, timezone, outputsize) {
  const url = new URL('https://api.twelvedata.com/time_series');

  url.search = new URLSearchParams({
    symbol,
    interval,
    outputsize: String(outputsize),
    timezone,
    apikey: apiKey,
    format: 'JSON'
  }).toString();

  const response = await fetch(url, {
    signal: AbortSignal.timeout(18000)
  });

  const body = await response.json();

  if (!response.ok || body.status === 'error' || !Array.isArray(body.values)) {
    throw new Error(body.message || 'خطا در دریافت کندل‌ها');
  }

  return body;
}

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
      error: 'کلید API تنظیم نشده است'
    });
  }

  const cacheKey = symbol + ':' + tf;
  const cached = cache.get(cacheKey);

  if (cached && Date.now() - cached.at < 60000) {
    return res.json({ ...cached.data, cached: true });
  }

  try {
    const primary = await requestSeries(
      symbols[symbol],
      intervals[tf],
      apiKey,
      'UTC',
      200
    );

    const candles = normalizeCandles(primary.values);

    if (candles.length < 55) {
      throw new Error('کندل کافی دریافت نشد');
    }

    const reportedTimezone = String(
      primary.meta?.timezone || ''
    ).trim();

    let timezoneConfirmed =
      /^(UTC|Etc\/UTC|GMT|Etc\/GMT)$/i.test(reportedTimezone);

    let verification = timezoneConfirmed
      ? 'provider_metadata'
      : 'unverified';

    // فقط برای تایم‌فریم‌های درون‌روزی تلاش به تأیید مستقل می‌کنیم.
    // درخواست دوم ممکن است سهمیه API را مصرف کند.
    if (!timezoneConfirmed && minutes[tf] < 1440) {
      try {
        const comparison = await requestSeries(
          symbols[symbol],
          intervals[tf],
          apiKey,
          'America/New_York',
          5
        );

        const primaryLast = primary.values[0];
        const comparisonLast = comparison.values[0];

        if (primaryLast && comparisonLast) {
          const utcTime = parseUTC(primaryLast.datetime);

          const nyString = comparisonLast.datetime;

          // اختلاف ساعت نیویورک با UTC برای همان لحظه
          const formatter = new Intl.DateTimeFormat('en-US', {
            timeZone: 'America/New_York',
            year: 'numeric',
            month: '2-digit',
            day: '2-digit',
            hour: '2-digit',
            minute: '2-digit',
            second: '2-digit',
            hourCycle: 'h23'
          });

          const parts = Object.fromEntries(
            formatter.formatToParts(new Date(utcTime))
              .filter(p => p.type !== 'literal')
              .map(p => [p.type, p.value])
          );

          const expectedNY =
            `${parts.year}-${parts.month}-${parts.day} ` +
            `${parts.hour}:${parts.minute}:${parts.second}`;

          const samePrice =
            Number(primaryLast.close) ===
            Number(comparisonLast.close);

          const sameBar =
            Number.isFinite(utcTime) &&
            expectedNY === nyString &&
            samePrice;

          if (sameBar) {
            timezoneConfirmed = true;
            verification = 'independent_timezone_comparison';
          }
        }
      } catch (error) {
        console.warn('Timezone verification:', error.message);
      }
    }

    const intervalMs = minutes[tf] * 60000;
    const now = Date.now();

    let closedCandles = [];

    if (timezoneConfirmed) {
      closedCandles = candles.filter(c => {
        const timestamp = parseUTC(c.time);

        return Number.isFinite(timestamp) &&
          timestamp + intervalMs <= now;
      });
    }

    const lastClosed = closedCandles.at(-1);

    const lastClosedTimestamp = lastClosed
      ? parseUTC(lastClosed.time)
      : NaN;

    const ageMinutes = Number.isFinite(lastClosedTimestamp)
      ? (now - lastClosedTimestamp) / 60000
      : null;

    const maximumAgeMinutes = Math.max(
      minutes[tf] * 3,
      15
    );

    const fresh =
      timezoneConfirmed &&
      closedCandles.length >= 55 &&
      ageMinutes !== null &&
      ageMinutes >= minutes[tf] &&
      ageMinutes <= maximumAgeMinutes;

    const day = new Date().getUTCDay();

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
        verification,
        lastCandleAgeMinutes: ageMinutes,
        maximumAgeMinutes,
        fresh,
        weekend,
        signalAllowed
      },
      note: 'تحلیل آزمایشی؛ قیمت ممکن است با Pocket Option متفاوت باشد'
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
  console.log('PocketBot Pro V2.2 running');
});
