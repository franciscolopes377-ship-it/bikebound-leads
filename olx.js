import { randomBytes } from 'node:crypto';
import { db, getConfig, setConfig } from './db.js';
import { getStock } from './stock.js';
import { importarConversas } from './import.js';
import { classificarConversa } from './classificar.js';
import { responderUltima } from './leads.js';

// Ligação à API de parceiros do OLX (OAuth 2.0). Só leitura: as respostas continuam a ser rascunhos aprovados pela equipa.
const env = k => process.env[k] || '';
const HOST = () => (env('OLX_HOST') || 'https://www.olx.pt').replace(/\/+$/, '');
const REDIRECT = () => env('OLX_REDIRECT_URI') || 'https://bikebound-leads-production.up.railway.app/olx/callback';
const SCOPE = 'v2 read write';
export const olxConfigurado = () => !!(env('OLX_CLIENT_ID') && env('OLX_CLIENT_SECRET'));

db.exec(`
CREATE TABLE IF NOT EXISTS olx_threads (uuid TEXT PRIMARY KEY, advert_id INTEGER, interlocutor_id INTEGER, total_count INTEGER, lead_id INTEGER, ignorada INTEGER DEFAULT 0, visto_em TEXT);
CREATE TABLE IF NOT EXISTS olx_adverts (id INTEGER PRIMARY KEY, url TEXT, title TEXT, status TEXT);
CREATE TABLE IF NOT EXISTS olx_users (id INTEGER PRIMARY KEY, name TEXT);
`);

// ---------- autorização ----------
export function urlAutorizacao() {
  if (!olxConfigurado()) throw Object.assign(new Error('Falta OLX_CLIENT_ID / OLX_CLIENT_SECRET no Railway'), { status: 400 });
  const state = randomBytes(16).toString('hex');
  setConfig('olx_state', state);
  const q = new URLSearchParams({ client_id: env('OLX_CLIENT_ID'), response_type: 'code', state, scope: SCOPE, redirect_uri: REDIRECT() });
  return `${HOST()}/oauth/authorize/?${q}`;
}

async function pedirToken(corpo, fetchImpl) {
  const r = await fetchImpl(`${HOST()}/api/open/oauth/token`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ client_id: env('OLX_CLIENT_ID'), client_secret: env('OLX_CLIENT_SECRET'), ...corpo }),
    signal: AbortSignal.timeout(20000)
  });
  const txt = await r.text();
  if (!r.ok) throw new Error(`OLX recusou o token (${r.status}): ${txt.slice(0, 200)}`);
  const t = JSON.parse(txt);
  if (!t.access_token) throw new Error('Resposta do OLX sem access_token');
  setConfig('olx_access', t.access_token);
  if (t.refresh_token) setConfig('olx_refresh', t.refresh_token);
  setConfig('olx_expira', String(Date.now() + (Number(t.expires_in) || 3600) * 1000));
  return t.access_token;
}

export async function concluirAutorizacao({ code, state }, { fetchImpl = fetch } = {}) {
  const esperado = getConfig('olx_state');
  if (!code || !state || !esperado || state !== esperado) throw Object.assign(new Error('Pedido de autorização inválido ou expirado. Volta a clicar em "Ligar ao OLX".'), { status: 400 });
  setConfig('olx_state', '');
  await pedirToken({ grant_type: 'authorization_code', code, scope: SCOPE, redirect_uri: REDIRECT() }, fetchImpl);
  if (!getConfig('olx_ligado_em')) setConfig('olx_ligado_em', new Date().toISOString());
  setConfig('olx_erro', '');
}

async function token(fetchImpl, forcar = false) {
  const access = getConfig('olx_access'), refresh = getConfig('olx_refresh');
  if (!access && !refresh) throw Object.assign(new Error('OLX ainda não está ligado'), { status: 400 });
  if (!forcar && access && Number(getConfig('olx_expira') || 0) > Date.now() + 5 * 60 * 1000) return access;
  if (!refresh) throw new Error('Sessão do OLX expirou: volta a ligar ao OLX');
  return pedirToken({ grant_type: 'refresh_token', refresh_token: refresh }, fetchImpl);
}

export function desligar() {
  for (const k of ['olx_access', 'olx_refresh', 'olx_expira', 'olx_state']) setConfig(k, '');
}

// ---------- pedidos à API ----------
const espera = ms => new Promise(r => setTimeout(r, ms));
async function api(caminho, { fetchImpl, pausa }) {
  for (let tentativa = 0; tentativa < 3; tentativa++) {
    const r = await fetchImpl(`${HOST()}/api/partner${caminho}`, {
      headers: { authorization: `Bearer ${await token(fetchImpl, tentativa > 0)}`, version: '2.0', accept: 'application/json' },
      signal: AbortSignal.timeout(20000)
    });
    if (pausa) await espera(pausa);
    if (r.status === 401 && tentativa === 0) continue; // token expirado: renova e repete
    if (r.status === 429) { await espera(Math.min(Number(r.headers.get('retry-after')) || 30, 120) * 1000); continue; }
    if (!r.ok) throw new Error(`OLX ${r.status} em ${caminho.split('?')[0]}: ${(await r.text()).slice(0, 150)}`);
    const j = await r.json();
    return j && typeof j === 'object' && 'data' in j ? j.data : j;
  }
  throw new Error(`OLX não respondeu em ${caminho.split('?')[0]}`);
}

// ---------- ligação aos anúncios do stock ----------
const chaveAnuncio = url => { const m = /\/anuncio\/([^?#]+?)(?:\.html)?(?:[?#]|$)/i.exec(String(url || '')); return m ? m[1].toLowerCase() : null; };

async function anuncio(id, ctx) {
  let a = db.prepare('SELECT * FROM olx_adverts WHERE id=?').get(id);
  if (!a) {
    let d = null;
    try { d = await api(`/adverts/${id}`, ctx); } catch (e) { if (!/OLX 40[34]/.test(e.message)) throw e; }
    db.prepare('INSERT OR REPLACE INTO olx_adverts (id, url, title, status) VALUES (?,?,?,?)').run(id, d?.url || null, d?.title || null, d?.status || 'indisponivel');
    a = db.prepare('SELECT * FROM olx_adverts WHERE id=?').get(id);
  }
  return a;
}

async function nomeUtilizador(id, ctx) {
  const u = db.prepare('SELECT name FROM olx_users WHERE id=?').get(id);
  if (u) return u.name;
  let nome = null;
  try { nome = (await api(`/users/${id}`, ctx))?.name || null; } catch { /* sem nome */ }
  db.prepare('INSERT OR REPLACE INTO olx_users (id, name) VALUES (?,?)').run(id, nome);
  return nome;
}

// ---------- sincronização ----------
let aCorrer = null;
export function olxStatus() {
  return {
    configurado: olxConfigurado(),
    ligado: !!(getConfig('olx_refresh') || getConfig('olx_access')),
    ligado_em: getConfig('olx_ligado_em') || null,
    ultima_sync: getConfig('olx_ultima_sync') || null,
    erro: getConfig('olx_erro') || null,
    resumo: getConfig('olx_resumo') ? JSON.parse(getConfig('olx_resumo')) : null,
    a_correr: !!aCorrer
  };
}

export function syncOlx(opcoes = {}) {
  if (aCorrer) return aCorrer;
  aCorrer = correr(opcoes).finally(() => { aCorrer = null; });
  return aCorrer;
}

async function correr({ fetchImpl = fetch, pausa = 120, maxThreads = 3000, gerarRascunhos = true } = {}) {
  const ctx = { fetchImpl, pausa };
  const res = { conversas_vistas: 0, conversas_stock: 0, mensagens_novas: 0, leads_novas: 0, rascunhos: 0, ignoradas: 0 };
  try {
    const porChave = new Map(getStock().filter(m => m.link).map(m => [chaveAnuncio(m.link), m]));
    const ligadoEm = Date.parse(getConfig('olx_ligado_em') || '') || Date.now();
    const pendentes = [];
    for (let offset = 0; offset < maxThreads; offset += 50) {
      const lote = await api(`/threads?offset=${offset}&limit=50`, ctx);
      if (!Array.isArray(lote) || !lote.length) break;
      for (const t of lote) {
        const uuid = String(t.uuid || t.id || '').toLowerCase();
        if (!uuid) continue;
        res.conversas_vistas++;
        const antes = db.prepare('SELECT * FROM olx_threads WHERE uuid=?').get(uuid);
        if (antes && antes.total_count === t.total_count && (antes.lead_id || antes.ignorada)) continue; // sem novidades
        const a = await anuncio(t.advert_id, ctx);
        const mota = porChave.get(chaveAnuncio(a?.url));
        if (!mota) {
          db.prepare('INSERT OR REPLACE INTO olx_threads (uuid, advert_id, interlocutor_id, total_count, lead_id, ignorada, visto_em) VALUES (?,?,?,?,NULL,1,CURRENT_TIMESTAMP)')
            .run(uuid, t.advert_id, t.interlocutor_id, t.total_count);
          res.ignoradas++;
          continue;
        }
        pendentes.push({ t, uuid, mota });
      }
      if (lote.length < 50) break;
    }

    for (const { t, uuid, mota } of pendentes) {
      const msgs = await api(`/threads/${uuid}/messages`, ctx);
      if (!Array.isArray(msgs) || !msgs.length) continue;
      const nome = await nomeUtilizador(t.interlocutor_id, ctx);
      const mensagens = msgs
        .filter(m => typeof m.text === 'string' && m.text.trim())
        .sort((x, y) => Date.parse(x.created_at) - Date.parse(y.created_at))
        .map(m => ({ direcao: m.type === 'sent' ? 'outbound' : 'inbound', texto: m.text, data: m.created_at, externo_id: 'm:' + String(m.uuid || m.id).toLowerCase() }));
      if (!mensagens.length) continue;
      // Classificação só para leads novas: nas existentes mantém-se o que a equipa ou o assistente definiram.
      const existe = db.prepare('SELECT 1 FROM leads WHERE externo_id=? UNION SELECT 1 FROM lead_externos WHERE externo_id=?').get('imp:olx:' + uuid, 'imp:olx:' + uuid);
      const cls = existe ? {} : classificarConversa(mensagens);
      const r = importarConversas([{ canal: 'olx', externo_id: 'olx:' + uuid, nome, mota_id: mota.id, ...cls, mensagens }]);
      const info = r.leads?.[0];
      if (!info) continue;
      db.prepare('UPDATE leads SET origem=COALESCE(origem, ?) WHERE id=?').run('olx', info.lead_id);
      db.prepare('INSERT OR REPLACE INTO olx_threads (uuid, advert_id, interlocutor_id, total_count, lead_id, ignorada, visto_em) VALUES (?,?,?,?,?,0,CURRENT_TIMESTAMP)')
        .run(uuid, t.advert_id, t.interlocutor_id, t.total_count, info.lead_id);
      res.conversas_stock++; res.mensagens_novas += r.mensagens_novas; res.leads_novas += r.leads_novas;
      // Se a equipa já respondeu diretamente no OLX, o rascunho antigo deixa de fazer sentido.
      db.prepare(`UPDATE mensagens SET estado='descartada' WHERE lead_id=? AND estado='rascunho'
        AND criado_em <= (SELECT MAX(criado_em) FROM mensagens WHERE lead_id=? AND direcao='outbound' AND estado='enviada')`).run(info.lead_id, info.lead_id);

      // Mensagem nova do cliente desde que a app foi ligada, ainda sem resposta → rascunho e aviso à equipa.
      const ultima = mensagens[mensagens.length - 1];
      if (gerarRascunhos && info.novas > 0 && ultima.direcao === 'inbound' && Date.parse(ultima.data) >= ligadoEm) {
        const out = await responderUltima(info.lead_id, 'olx');
        if (out?.rascunho_id) res.rascunhos++;
        else if (!out?.adiada) db.prepare('UPDATE leads SET alertar=1 WHERE id=?').run(info.lead_id);
      }
    }
    setConfig('olx_ultima_sync', new Date().toISOString());
    setConfig('olx_erro', '');
    setConfig('olx_resumo', JSON.stringify(res));
    return res;
  } catch (e) {
    setConfig('olx_erro', e.message);
    throw e;
  }
}

export function startOlxSync(minutos = 2) {
  const corre = () => { if (olxConfigurado() && olxStatus().ligado) syncOlx().catch(e => console.error('sync OLX:', e.message)); };
  setTimeout(corre, 15000);
  setInterval(corre, minutos * 60 * 1000);
}
