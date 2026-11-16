import http from 'node:http';
import { readFileSync } from 'node:fs';
import { timingSafeEqual } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { db } from './db.js';
import { importStock, getStock } from './stock.js';
import { processInbound } from './leads.js';

const here = dirname(fileURLToPath(import.meta.url));
const PORT = process.env.PORT || 3000;
const PASS = process.env.APP_PASSWORD || '';
const VERIFY_TOKEN = process.env.WHATSAPP_VERIFY_TOKEN || '';
const AUTO_SEND = process.env.AUTO_SEND === '1'; // reservado: modo automático (ainda não ativo)

const safeEq = (a, b) => { const x = Buffer.from(a), y = Buffer.from(b); return x.length === y.length && timingSafeEqual(x, y); };

function authed(req) {
  if (!PASS) return false;
  const h = req.headers.authorization || '';
  if (!h.startsWith('Basic ')) return false;
  const [, p = ''] = Buffer.from(h.slice(6), 'base64').toString().split(/:(.*)/s);
  return safeEq(p, PASS);
}

const send = (res, code, body, type = 'application/json') => {
  res.writeHead(code, { 'content-type': type + '; charset=utf-8', 'cache-control': 'no-store' });
  res.end(type === 'application/json' ? JSON.stringify(body) : body);
};

const readBody = req => new Promise((ok, ko) => {
  let d = ''; req.on('data', c => { d += c; if (d.length > 2e6) { ko(new Error('Corpo demasiado grande')); req.destroy(); } });
  req.on('end', () => ok(d)); req.on('error', ko);
});

const page = readFileSync(join(here, 'index.html'), 'utf8');

export const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, 'http://x');
    const p = url.pathname;

    // Webhook WhatsApp (a Meta não envia Basic Auth)
    if (p === '/webhook/whatsapp') {
      if (req.method === 'GET') {
        const ok = url.searchParams.get('hub.mode') === 'subscribe' && VERIFY_TOKEN && url.searchParams.get('hub.verify_token') === VERIFY_TOKEN;
        return ok ? send(res, 200, url.searchParams.get('hub.challenge'), 'text/plain') : send(res, 403, 'forbidden', 'text/plain');
      }
      if (req.method === 'POST') {
        const body = JSON.parse((await readBody(req)) || '{}');
        send(res, 200, { ok: true }); // responder logo à Meta
        for (const e of body.entry || []) for (const c of e.changes || []) {
          const v = c.value || {};
          const nomes = Object.fromEntries((v.contacts || []).map(x => [x.wa_id, x.profile?.name]));
          for (const m of v.messages || []) {
            if (m.type !== 'text') continue;
            processInbound({ canal: 'whatsapp', nome: nomes[m.from], telefone: m.from, texto: m.text.body })
              .catch(err => console.error('webhook', err.message));
          }
        }
        return;
      }
    }

    if (!authed(req)) {
      res.writeHead(401, { 'www-authenticate': 'Basic realm="BikeBound Leads"' });
      return res.end('Autenticação necessária');
    }

    if (req.method === 'GET' && p === '/') return send(res, 200, page, 'text/html');

    if (req.method === 'GET' && p === '/api/leads') {
      const c = url.searchParams.get('classificacao');
      const rows = db.prepare(`SELECT l.*,
          (SELECT COUNT(*) FROM mensagens m WHERE m.lead_id=l.id AND m.estado='rascunho') AS rascunhos,
          (SELECT texto FROM mensagens m WHERE m.lead_id=l.id AND m.direcao='inbound' ORDER BY id DESC LIMIT 1) AS ultima
        FROM leads l ${c ? 'WHERE classificacao=?' : ''} ORDER BY alertar DESC, atualizado_em DESC`).all(...(c ? [c] : []));
      return send(res, 200, rows);
    }

    let m;
    if (req.method === 'GET' && (m = p.match(/^\/api\/leads\/(\d+)$/))) {
      const lead = db.prepare('SELECT * FROM leads WHERE id=?').get(m[1]);
      if (!lead) return send(res, 404, { erro: 'Lead não encontrada' });
      return send(res, 200, { lead, mensagens: db.prepare('SELECT * FROM mensagens WHERE lead_id=? ORDER BY id').all(m[1]) });
    }

    if (req.method === 'PATCH' && (m = p.match(/^\/api\/leads\/(\d+)$/))) {
      const b = JSON.parse((await readBody(req)) || '{}');
      const estados = ['novo', 'em_curso', 'visita_marcada', 'vendida', 'perdida'];
      if (b.estado && !estados.includes(b.estado)) return send(res, 400, { erro: 'Estado inválido' });
      if (b.estado) db.prepare('UPDATE leads SET estado=?, atualizado_em=CURRENT_TIMESTAMP WHERE id=?').run(b.estado, m[1]);
      if (b.alertar === false) db.prepare('UPDATE leads SET alertar=0 WHERE id=?').run(m[1]);
      return send(res, 200, { ok: true });
    }

    if (req.method === 'POST' && p === '/api/mensagens') {
      const b = JSON.parse((await readBody(req)) || '{}');
      return send(res, 200, await processInbound(b));
    }

    if (req.method === 'POST' && (m = p.match(/^\/api\/mensagens\/(\d+)\/estado$/))) {
      const b = JSON.parse((await readBody(req)) || '{}');
      if (!['enviada', 'descartada', 'rascunho'].includes(b.estado)) return send(res, 400, { erro: 'Estado inválido' });
      const msg = db.prepare('SELECT * FROM mensagens WHERE id=? AND direcao=\'outbound\'').get(m[1]);
      if (!msg) return send(res, 404, { erro: 'Mensagem não encontrada' });
      db.prepare('UPDATE mensagens SET estado=?, texto=COALESCE(?,texto) WHERE id=?').run(b.estado, b.texto ?? null, m[1]);
      return send(res, 200, { ok: true });
    }

    if (p === '/api/stock') {
      if (req.method === 'GET') return send(res, 200, getStock());
      if (req.method === 'POST') { try { return send(res, 200, { importadas: importStock(await readBody(req)) }); } catch (e) { return send(res, 400, { erro: e.message }); } }
    }

    send(res, 404, { erro: 'Não encontrado' });
  } catch (e) {
    console.error(e);
    if (!res.headersSent) send(res, 500, { erro: e.message });
  }
});

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  if (!PASS) console.warn('AVISO: defina APP_PASSWORD, senão ninguém consegue entrar.');
  server.listen(PORT, () => console.log(`BikeBound Leads em http://localhost:${PORT} (auto-envio: ${AUTO_SEND ? 'ON' : 'OFF'})`));
}
