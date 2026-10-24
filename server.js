import express from 'express';
const app=express();
app.use(express.static('public'));
const symbols={EURUSD:'EUR/USD',GBPUSD:'GBP/USD',USDJPY:'USD/JPY',USDCHF:'USD/CHF',AUDUSD:'AUD/USD',USDCAD:'USD/CAD',NZDUSD:'NZD/USD',EURGBP:'EUR/GBP',EURJPY:'EUR/JPY',GBPJPY:'GBP/JPY',XAUUSD:'XAU/USD'};
const intervals={m1:'1min',m5:'5min',m15:'15min',m30:'30min',h1:'1h',h4:'4h',d1:'1day',w1:'1week'};
const cache=new Map();
app.get('/api/candles',async(req,res)=>{
 const symbol=String(req.query.symbol||'EURUSD').toUpperCase(),tf=String(req.query.tf||'m1');
 if(!symbols[symbol]||!intervals[tf])return res.status(400).json({error:'نماد یا تایم‌فریم پشتیبانی نمی‌شود'});
 const apiKey=process.env.TWELVE_DATA_API_KEY;
 if(!apiKey)return res.status(503).json({error:'کلید TWELVE_DATA_API_KEY روی سرور تنظیم نشده است'});
 const key=symbol+tf,old=cache.get(key);
 if(old&&Date.now()-old.time<60000)return res.json({...old.data,cached:true});
 try{
  const url=new URL('https://api.twelvedata.com/time_series');
  url.search=new URLSearchParams({symbol:symbols[symbol],interval:intervals[tf],outputsize:'200',apikey:apiKey,format:'JSON'}).toString();
  const response=await fetch(url,{signal:AbortSignal.timeout(18000)});
  const body=await response.json();
  if(!response.ok||body.status==='error'||!Array.isArray(body.values))throw Error(body.message||'پاسخ معتبر از Twelve Data دریافت نشد');
  const candles=body.values.map(v=>({time:v.datetime,open:Number(v.open),high:Number(v.high),low:Number(v.low),close:Number(v.close)})).filter(v=>[v.open,v.high,v.low,v.close].every(Number.isFinite)).reverse();
  if(candles.length<55)throw Error('داده کافی برای تحلیل دریافت نشد');
  const result={symbol,tf,candles,receivedAt:new Date().toISOString(),source:'Twelve Data',note:'داده ممکن است تأخیر داشته باشد و با قیمت Pocket Option متفاوت باشد'};
  cache.set(key,{time:Date.now(),data:result});res.json(result);
 }catch(e){res.status(502).json({error:String(e.message||e)})}
});
app.get('/health',(_,res)=>res.json({ok:true,source:'Twelve Data',configured:!!process.env.TWELVE_DATA_API_KEY}));
app.listen(process.env.PORT||8787,'0.0.0.0');
