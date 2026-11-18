import { db, normTel, getConfig } from './db.js';

// ---- telefone escrito pelo cliente no chat (ex.: "o meu número é 912 345 678") ----
const RE_TEL = /(?<![\d])(?:(?:\+|00)?351[\s.-]?)?(9[1236]\d(?:[\s.-]?\d){6}|2\d(?:[\s.-]?\d){7})(?![\d])/g;
const numerosDoStand = () => new Set(['927887107', '916808800', normTel(getConfig('telefone_stand'))].filter(Boolean));

export function telefoneNoTexto(texto) {
  const doStand = numerosDoStand();
  for (const m of String(texto || '').matchAll(RE_TEL)) {
    const n = normTel(m[1]);
    if (n.length === 9 && !doStand.has(n)) return n;
  }
  return null;
}

// Guarda o telefone na lead se ainda não tiver nenhum. Não junta leads sozinho: aparece como sugestão.
export function registaTelefoneDoTexto(leadId, texto) {
  const tel = telefoneNoTexto(texto);
  if (!tel) return null;
  const r = db.prepare('UPDATE leads SET telefone=COALESCE(telefone, ?), telefone_norm=? WHERE id=? AND telefone_norm IS NULL').run(tel, tel, leadId);
  return r.changes ? tel : null;
}

// ---- sugestões de leads que parecem ser o mesmo cliente ----
const simples = s => String(s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9 ]/g, ' ').trim();
const primeiroNome = s => simples(s).split(/\s+/)[0] || '';

export function sugestoes(leadId) {
  const l = db.prepare('SELECT * FROM leads WHERE id=?').get(leadId);
  if (!l) return [];
  const outras = db.prepare('SELECT * FROM leads WHERE id<>?').all(leadId);
  const res = [];
  for (const o of outras) {
    const motivos = [];
    if (l.telefone_norm && o.telefone_norm === l.telefone_norm) motivos.push('mesmo telefone');
    const nomeIgual = primeiroNome(l.nome).length >= 3 && primeiroNome(l.nome) === primeiroNome(o.nome);
    const motaIgual = l.mota_interesse && o.mota_interesse && simples(l.mota_interesse) === simples(o.mota_interesse);
    if (nomeIgual && motaIgual) motivos.push('mesmo nome e mesma mota');
    else if (nomeIgual && o.canal !== l.canal) motivos.push('mesmo nome, noutro canal');
    if (motivos.length) res.push({ id: o.id, nome: o.nome, telefone: o.telefone, canal: o.canal, mota_interesse: o.mota_interesse, motivos, forte: motivos.includes('mesmo telefone') || motivos.includes('mesmo nome e mesma mota') });
  }
  return res.sort((a, b) => b.forte - a.forte).slice(0, 5);
}

// ---- juntar duas leads (a "origem" passa para dentro do "destino" e deixa de existir) ----
const ORDEM_CLASSE = { quente: 4, retoma: 3, morno: 2, frio: 1 };
const ORDEM_ESTADO = { vendida: 5, perdida: 4, visita_marcada: 3, em_curso: 2, novo: 1 };
const melhor = (a, b, ordem) => ((ordem[b] || 0) > (ordem[a] || 0) ? b : a);

export function juntarLeads(destinoId, origemId) {
  destinoId = Number(destinoId); origemId = Number(origemId);
  if (!destinoId || !origemId || destinoId === origemId) throw Object.assign(new Error('Escolhe duas leads diferentes'), { status: 400 });
  const d = db.prepare('SELECT * FROM leads WHERE id=?').get(destinoId);
  const o = db.prepare('SELECT * FROM leads WHERE id=?').get(origemId);
  if (!d || !o) throw Object.assign(new Error('Lead não encontrada'), { status: 404 });
  db.exec('BEGIN');
  try {
    db.prepare('UPDATE mensagens SET lead_id=? WHERE lead_id=?').run(destinoId, origemId);
    // Fica só o rascunho mais recente.
    const rasc = db.prepare("SELECT id FROM mensagens WHERE lead_id=? AND estado='rascunho' ORDER BY id DESC").all(destinoId);
    for (const r of rasc.slice(1)) db.prepare("UPDATE mensagens SET estado='descartada' WHERE id=?").run(r.id);
    // A conversa de origem (ex.: OLX importado) continua a apontar para esta lead em futuras importações.
    for (const ext of [o.externo_id, ...db.prepare('SELECT externo_id FROM lead_externos WHERE lead_id=?').all(origemId).map(x => x.externo_id)].filter(Boolean)) {
      db.prepare('INSERT OR REPLACE INTO lead_externos (externo_id, lead_id) VALUES (?,?)').run(ext, destinoId);
    }
    db.prepare('DELETE FROM lead_externos WHERE lead_id=?').run(origemId);
    db.prepare(`UPDATE leads SET
        nome=COALESCE(nome, ?), telefone=COALESCE(telefone, ?), telefone_norm=COALESCE(telefone_norm, ?),
        mota_interesse=COALESCE(mota_interesse, ?), quando_quer_ver=COALESCE(quando_quer_ver, ?), resumo_equipa=COALESCE(resumo_equipa, ?),
        retoma=MAX(retoma, ?), financiamento=MAX(financiamento, ?), alertar=MAX(alertar, ?),
        classificacao=?, estado=?, criado_em=MIN(criado_em, ?), atualizado_em=MAX(atualizado_em, ?), origem=COALESCE(origem, ?)
      WHERE id=?`)
      .run(o.nome, o.telefone, o.telefone_norm, o.mota_interesse, o.quando_quer_ver, o.resumo_equipa,
        o.retoma, o.financiamento, o.alertar,
        melhor(d.classificacao, o.classificacao, ORDEM_CLASSE), melhor(d.estado, o.estado, ORDEM_ESTADO),
        o.criado_em, o.atualizado_em, o.origem, destinoId);
    db.prepare('DELETE FROM leads WHERE id=?').run(origemId);
    db.exec('COMMIT');
  } catch (e) { db.exec('ROLLBACK'); throw e; }
  return db.prepare('SELECT * FROM leads WHERE id=?').get(destinoId);
}
