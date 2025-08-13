import express from 'express';
import axios from 'axios';
import morgan from 'morgan';
import pino from 'pino';
import pinoHttp from 'pino-http';
import validator from 'validator';
import contentDisposition from 'content-disposition';

const app = express();
const logger = pino({ level: process.env.LOG_LEVEL || 'info' });
app.use(pinoHttp({ logger }));
app.use(morgan('tiny'));

const PORT = process.env.PORT || 3000;

// اسماء الدومينات المسموح بها (افصلها بفواصل)؛ اتركها فاضية للسماح للجميع
const ALLOWLIST = (process.env.ALLOWLIST || '')
  .split(',')
  .map(s => s.trim())
  .filter(Boolean);

const ALLOWED_MIME_PREFIX = ['video/','audio/','image/','application/pdf'];

function isAllowedDomain(url) {
  if (ALLOWLIST.length === 0) return true;
  try {
    const u = new URL(url);
    return ALLOWLIST.some(d => u.hostname === d || u.hostname.endsWith(`.${d}`));
  } catch { return false; }
}
function isHttps(url) { try { return new URL(url).protocol === 'https:'; } catch { return false; } }

function pickFilename(res, fallback = '') {
  const cd = res.headers['content-disposition'];
  if (cd) {
    try {
      const parsed = contentDisposition.parse(cd);
      if (parsed?.parameters?.filename) return parsed.parameters.filename;
    } catch {}
  }
  try {
    const u = new URL(res.request?.res?.responseUrl || res.config.url);
    const last = u.pathname.split('/').filter(Boolean).pop() || '';
    if (last) return decodeURIComponent(last);
  } catch {}
  return fallback || `download-${Date.now()}`;
}

// فحص معلومات الرابط فقط
app.get('/resolve', async (req, res) => {
  const { url } = req.query;
  if (!url || !validator.isURL(url, { require_tld: false })) return res.status(400).json({ ok:false, error:'Invalid URL' });
  if (!isHttps(url)) return res.status(400).json({ ok:false, error:'Only HTTPS is allowed' });
  if (!isAllowedDomain(url)) return res.status(403).json({ ok:false, error:'Domain not allowed' });

  try {
    const head = await axios.head(url, { maxRedirects: 5, validateStatus: null });
    const finalUrl = head.request?.res?.responseUrl || url;
    const mime = head.headers['content-type'] || '';
    const len = head.headers['content-length'] ? Number(head.headers['content-length']) : null;

    const allowed = ALLOWED_MIME_PREFIX.some(p => mime.startsWith(p));
    if (!allowed) return res.status(415).json({ ok:false, error:'Unsupported content-type', contentType:mime });

    const filename = pickFilename(head, '');
    res.json({ ok:true, url:finalUrl, filename, contentType:mime, bytes:len });
  } catch (e) {
    req.log?.error?.(e);
    res.status(500).json({ ok:false, error:'Resolve failed' });
  }
});

// تنزيل عبر الخادم (Proxy)
app.get('/download', async (req, res) => {
  const { url, filename } = req.query;
  if (!url || !validator.isURL(url, { require_tld: false })) return res.status(400).json({ ok:false, error:'Invalid URL' });
  if (!isHttps(url)) return res.status(400).json({ ok:false, error:'Only HTTPS is allowed' });
  if (!isAllowedDomain(url)) return res.status(403).json({ ok:false, error:'Domain not allowed' });

  try {
    const upstream = await axios.get(url, { responseType:'stream', maxRedirects:5, validateStatus:null });
    const mime = upstream.headers['content-type'] || 'application/octet-stream';
    const name = filename || pickFilename(upstream, '');
    res.setHeader('Content-Type', mime);
    res.setHeader('Content-Disposition', contentDisposition(name, { type:'attachment' }));
    upstream.data.pipe(res);
  } catch (e) {
    req.log?.error?.(e);
    res.status(500).json({ ok:false, error:'Download proxy failed' });
  }
});

app.get('/', (req,res)=>res.json({ ok:true, service:'Ziply proxy', endpoints:['/resolve?url=...','/download?url=...&filename=...'] }));
app.listen(PORT, ()=> logger.info(`Server on :${PORT}`));
