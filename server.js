import http from 'node:http';
import { readFileSync } from 'node:fs';
import { timingSafeEqual, createHmac, createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { db, getConfig, setConfig } from './db.js';
import { importStock, importPrecos, getStock } from './stock.js';
import { syncStock, syncStatus, startAutoSync } from './sync.js';
import { processInbound, registarSemResposta } from './leads.js';
import { instrucoesStand, assinaturaOlx, telefoneStand } from './assistant.js';
import { importarConversas } from './import.js';

const here = dirname(fileURLToPath(import.meta.url));
const PORT = process.env.PORT || 3000;
const env = k => process.env[k] || '';
const AUTO_SEND = env('AUTO_SEND') === '1'; // reservado: modo automático (ainda não ativo)

// Compara sem revelar, pelo tempo de resposta, quantos caracteres estão certos.
const hash = v => createHash('sha256').update(String(v), 'utf8').digest();
const safeEq = (a, b) => timingSafeEqual(hash(a), hash(b));

const CABECALHOS = {
  'cache-control': 'no-store',
  'x-content-type-options': 'nosniff',
  'x-frame-options': 'DENY',
  'referrer-policy': 'no-referrer',
  'content-security-policy': "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'"
};

const send = (res, code, body, type = 'application/json', extra = {}) => {
  res.writeHead(code, { ...CABECALHOS, 'content-type': type + '; charset=utf-8', ...extra });
  res.end(type === 'application/json' ? JSON.stringify(body) : body);
};
const erro = (status, msg) => Object.assign(new Error(msg), { status });

const readBody = (req, max = 2e6) => new Promise((ok, ko) => {
  const partes = []; let n = 0;
  req.on('data', c => { n += c.length; if (n > max) { ko(erro(413, 'Pedido demasiado grande')); req.destroy(); } else partes.push(c); });
  req.on('end', () => ok(Buffer.concat(partes)));
  req.on('error', ko);
});
const texto = async req => (await readBody(req)).toString('utf8');
const json = async req => {
  const t = await texto(req);
  try { const o = JSON.parse(t || '{}'); if (o && typeof o === 'object' && !Array.isArray(o)) return o; } catch { /* abaixo */ }
  throw erro(400, 'Pedido inválido');
};

// --- limite de tentativas de palavra-passe erradas, por endereço ---
const MAX_FALHAS = 10, JANELA = 15 * 60 * 1000;
const falhas = new Map();
const ipDe = req => String(req.headers['x-real-ip'] || String(req.headers['x-forwarded-for'] || '').split(',').pop().trim() || req.socket.remoteAddress || '?');
function bloqueado(ip) {
  const f = falhas.get(ip);
  if (!f) return 0;
  if (Date.now() > f.ate) { falhas.delete(ip); return 0; }
  return f.n >= MAX_FALHAS ? Math.ceil((f.ate - Date.now()) / 1000) : 0;
}
function registaFalha(ip) {
  const f = falhas.get(ip);
  if (!f || Date.now() > f.ate) falhas.set(ip, { n: 1, ate: Date.now() + JANELA });
  else f.n++;
  if (falhas.size > 5000) for (const [k, v] of falhas) if (Date.now() > v.ate) falhas.delete(k);
}
export const _limpaFalhas = () => falhas.clear();

// 'ok' | 'sem' (sem credenciais) | 'errada'
function autenticacao(req) {
  const pass = env('APP_PASSWORD');
  const h = req.headers.authorization || '';
  if (!h.startsWith('Basic ')) return 'sem';
  const [, p = ''] = Buffer.from(h.slice(6), 'base64').toString().split(/:(.*)/s);
  return pass && safeEq(p, pass) ? 'ok' : 'errada';
}

// Pedidos que alteram dados só são aceites vindos da própria página (impede que outro site os dispare).
function deOutroSite(req) {
  const s = req.headers['sec-fetch-site'];
  if (s) return !(s === 'same-origin' || s === 'none');
  const o = req.headers.origin;
  if (!o) return false;
  try { const h = new URL(o).host; return h !== req.headers.host && h !== req.headers['x-forwarded-host']; }
  catch { return true; }
}

const page = readFileSync(join(here, 'index.html'), 'utf8');
const TIPOS_WA = { image: 'imagem', audio: 'áudio', video: 'vídeo', document: 'documento', sticker: 'autocolante', location: 'localização', contacts: 'contacto' };

async function webhookWhatsApp(req, res, url) {
  if (req.method === 'GET') {
    const tok = env('WHATSAPP_VERIFY_TOKEN');
    const ok = url.searchParams.get('hub.mode') === 'subscribe' && tok && safeEq(url.searchParams.get('hub.verify_token') || '', tok);
    return ok ? send(res, 200, url.searchParams.get('hub.challenge') || '', 'text/plain') : send(res, 403, 'forbidden', 'text/plain');
  }
  if (req.method !== 'POST') return send(res, 405, 'method not allowed', 'text/plain');
  // Só aceita mensagens assinadas pela Meta com o segredo da app; sem segredo configurado, recusa tudo.
  const segredo = env('WHATSAPP_APP_SECRET');
  if (!segredo) return send(res, 403, 'forbidden', 'text/plain');
  const raw = await readBody(req, 1e6);
  const esperado = 'sha256=' + createHmac('sha256', segredo).update(raw).digest('hex');
  if (!safeEq(req.headers['x-hub-signature-256'] || '', esperado)) return send(res, 403, 'forbidden', 'text/plain');
  let body;
  try { body = JSON.parse(raw.toString('utf8') || '{}'); } catch { return send(res, 400, 'bad request', 'text/plain'); }
  send(res, 200, { ok: true }); // responder logo à Meta; o tratamento continua em segundo plano
  for (const e of body?.entry || []) for (const c of e?.changes || []) {
    const v = c?.value || {};
    const nomes = Object.fromEntries((v.contacts || []).map(x => [x.wa_id, x.profile?.name]));
    for (const m of v.messages || []) {
      if (!m?.from) continue;
      const comum = { canal: 'whatsapp', nome: nomes[m.from], telefone: m.from, externo_id: m.id ? `wa:${m.id}` : null };
      try {
        if (m.type === 'text' && m.text?.body) processInbound({ ...comum, texto: m.text.body }).catch(err => console.error('webhook', err.message));
        else registarSemResposta({ ...comum, texto: `[O cliente enviou: ${TIPOS_WA[m.type] || 'mensagem não suportada'}]` });
      } catch (err) { console.error('webhook', err.message); }
    }
  }
}

async function api(req, res, url) {
  const p = url.pathname, M = req.method;
  let m;

  if (M === 'GET' && p === '/') return send(res, 200, page, 'text/html');

  if (M === 'GET' && p === '/api/leads') {
    const c = url.searchParams.get('classificacao');
    const rows = db.prepare(`SELECT l.*,
        (SELECT COUNT(*) FROM mensagens m WHERE m.lead_id=l.id AND m.estado='rascunho') AS rascunhos,
        (SELECT texto FROM mensagens m WHERE m.lead_id=l.id AND m.direcao='inbound' ORDER BY id DESC LIMIT 1) AS ultima
      FROM leads l ${c ? 'WHERE classificacao=?' : ''} ORDER BY alertar DESC, atualizado_em DESC`).all(...(c ? [c] : []));
    return send(res, 200, rows);
  }

  if ((m = p.match(/^\/api\/leads\/(\d+)$/))) {
    const id = m[1];
    const lead = db.prepare('SELECT * FROM leads WHERE id=?').get(id);
    if (!lead) return send(res, 404, { erro: 'Lead não encontrada' });
    if (M === 'GET') return send(res, 200, { lead, mensagens: db.prepare('SELECT * FROM mensagens WHERE lead_id=? ORDER BY criado_em, id').all(id) });
    if (M === 'DELETE') {
      db.exec('BEGIN');
      try {
        db.prepare('DELETE FROM mensagens WHERE lead_id=?').run(id);
        db.prepare('DELETE FROM leads WHERE id=?').run(id);
        db.exec('COMMIT');
      } catch (e) { db.exec('ROLLBACK'); throw e; }
      return send(res, 200, { ok: true });
    }
    if (M === 'PATCH') {
      const b = await json(req);
      const estados = ['novo', 'em_curso', 'visita_marcada', 'vendida', 'perdida'];
      if (b.estado !== undefined && !estados.includes(b.estado)) return send(res, 400, { erro: 'Estado inválido' });
      if (b.estado) db.prepare('UPDATE leads SET estado=?, atualizado_em=CURRENT_TIMESTAMP WHERE id=?').run(b.estado, id);
      if (b.alertar === false) db.prepare('UPDATE leads SET alertar=0 WHERE id=?').run(id);
      return send(res, 200, { ok: true });
    }
  }

  if (M === 'POST' && p === '/api/mensagens') {
    const b = await json(req);
    return send(res, 200, await processInbound({
      canal: b.canal, nome: b.nome, telefone: b.telefone, texto: b.texto,
      lead_id: b.lead_id ? Number(b.lead_id) : null, mota_id: b.mota_id || null
    }));
  }

  if (M === 'POST' && (m = p.match(/^\/api\/mensagens\/(\d+)\/estado$/))) {
    const b = await json(req);
    if (!['enviada', 'descartada', 'rascunho'].includes(b.estado)) return send(res, 400, { erro: 'Estado inválido' });
    const msg = db.prepare("SELECT * FROM mensagens WHERE id=? AND direcao='outbound'").get(m[1]);
    if (!msg) return send(res, 404, { erro: 'Mensagem não encontrada' });
    const novo = typeof b.texto === 'string' && b.texto.trim() ? b.texto.trim().slice(0, 4000) : msg.texto;
    // Guarda o rascunho original quando a equipa o edita: serve para ver o que o assistente errou.
    const original = msg.texto_original ?? (novo !== msg.texto ? msg.texto : null);
    db.prepare('UPDATE mensagens SET estado=?, texto=?, texto_original=?, aviso=? WHERE id=?')
      .run(b.estado, novo, original, novo !== msg.texto ? null : msg.aviso, m[1]);
    return send(res, 200, { ok: true });
  }

  if (p === '/api/stock') {
    if (M === 'GET') return send(res, 200, getStock());
    if (M === 'POST') { try { return send(res, 200, { importadas: importStock(await texto(req)) }); } catch (e) { if (e.status) throw e; return send(res, 400, { erro: e.message }); } }
  }

  if (p === '/api/precos' && M === 'POST') {
    try { return send(res, 200, { importados: importPrecos(await texto(req)) }); }
    catch (e) { if (e.status) throw e; return send(res, 400, { erro: e.message }); }
  }

  if (p === '/api/sync') {
    if (M === 'GET') return send(res, 200, syncStatus());
    if (M === 'POST') { try { return send(res, 200, await syncStock()); } catch (e) { return send(res, 502, { erro: e.message }); } }
  }

  if (p === '/api/config') {
    if (M === 'GET') return send(res, 200, { instrucoes: instrucoesStand(), assinatura_olx: assinaturaOlx(), telefone_stand: telefoneStand() });
    if (M === 'PUT') {
      const b = await json(req);
      const limites = { instrucoes: 6000, assinatura_olx: 300, telefone_stand: 30 };
      for (const [k, max] of Object.entries(limites)) {
        if (b[k] === undefined) continue;
        if (typeof b[k] !== 'string' || b[k].length > max) return send(res, 400, { erro: `Campo "${k}" inválido ou demasiado longo (máx. ${max})` });
        setConfig(k, b[k].trim());
      }
      return send(res, 200, { ok: true });
    }
  }

  // Importação de conversas já existentes (não gera rascunhos nem envia nada).
  if (p === '/api/importar' && M === 'POST') return send(res, 200, importarConversas((await json(req)).conversas));

  // Cópia de segurança: todas as leads e conversas num ficheiro.
  if (p === '/api/export' && M === 'GET') {
    const dados = {
      exportado_em: new Date().toISOString(),
      leads: db.prepare('SELECT * FROM leads ORDER BY id').all(),
      mensagens: db.prepare('SELECT * FROM mensagens ORDER BY id').all(),
      precos: db.prepare('SELECT * FROM precos').all(),
      config: { instrucoes: getConfig('instrucoes'), assinatura_olx: getConfig('assinatura_olx'), telefone_stand: getConfig('telefone_stand') }
    };
    return send(res, 200, dados, 'application/json', { 'content-disposition': `attachment; filename="bikebound-leads-${dados.exportado_em.slice(0, 10)}.json"` });
  }

  send(res, 404, { erro: 'Não encontrado' });
}

export const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, 'http://x');
    if (url.pathname === '/webhook/whatsapp') return await webhookWhatsApp(req, res, url);

    const ip = ipDe(req);
    const espera = bloqueado(ip);
    if (espera) return send(res, 429, 'Demasiadas tentativas. Tente mais tarde.', 'text/plain', { 'retry-after': String(espera) });
    const a = autenticacao(req);
    if (a !== 'ok') {
      if (a === 'errada') { registaFalha(ip); await new Promise(r => setTimeout(r, 400)); }
      return send(res, 401, 'Autenticação necessária', 'text/plain', { 'www-authenticate': 'Basic realm="BikeBound Leads", charset="UTF-8"' });
    }
    if (!['GET', 'HEAD'].includes(req.method) && deOutroSite(req)) return send(res, 403, { erro: 'Pedido recusado (origem externa)' });

    await api(req, res, url);
  } catch (e) {
    if (!e.status) console.error(e);
    if (!res.headersSent) send(res, e.status || 500, { erro: e.status ? e.message : 'Erro interno' });
  }
});

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  if (!env('APP_PASSWORD')) console.warn('AVISO: defina APP_PASSWORD, senão ninguém consegue entrar.');
  else if (env('APP_PASSWORD').length < 12) console.warn('AVISO: APP_PASSWORD é curta; use pelo menos 12 caracteres.');
  if (!env('WHATSAPP_APP_SECRET')) console.warn('WhatsApp: sem WHATSAPP_APP_SECRET, o webhook recusa todas as mensagens.');
  startAutoSync();
  server.listen(PORT, () => console.log(`BikeBound Leads em http://localhost:${PORT} (auto-envio: ${AUTO_SEND ? 'ON' : 'OFF'})`));
}
