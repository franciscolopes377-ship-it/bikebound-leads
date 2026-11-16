import { db, normTel } from './db.js';
import { askClaude, aplicarAssinatura } from './assistant.js';
import { getStock } from './stock.js';
import { avisosRascunho } from './guard.js';

const CANAIS = ['whatsapp', 'olx'];
const MAX_TEXTO = 4000;

// Um cliente novo por cada conversa, exceto quando a equipa escolhe a lead (lead_id) ou o telefone coincide.
// Não se junta por nome: dois clientes "João" não podem ficar na mesma conversa.
export function findOrCreateLead({ canal, nome, telefone, lead_id }) {
  if (lead_id) {
    const l = db.prepare('SELECT * FROM leads WHERE id=?').get(lead_id);
    if (!l) throw Object.assign(new Error('Lead não encontrada'), { status: 404 });
    return l;
  }
  const tel = normTel(telefone);
  if (tel.length >= 9) {
    const l = db.prepare('SELECT * FROM leads WHERE telefone_norm=? ORDER BY id DESC').get(tel);
    if (l) return l;
  }
  const r = db.prepare('INSERT INTO leads (canal, nome, telefone, telefone_norm) VALUES (?,?,?,?)')
    .run(canal, nome ? String(nome).slice(0, 120) : null, telefone ? String(telefone).slice(0, 40) : null, tel || null);
  return db.prepare('SELECT * FROM leads WHERE id=?').get(r.lastInsertRowid);
}

// Fila por lead: as mensagens do mesmo cliente são tratadas uma de cada vez, pela ordem de chegada.
const filas = new Map();
function emFila(chave, fn) {
  const anterior = filas.get(chave) || Promise.resolve();
  const p = anterior.catch(() => {}).then(fn);
  filas.set(chave, p);
  p.catch(() => {}).finally(() => { if (filas.get(chave) === p) filas.delete(chave); });
  return p;
}

function guardaInbound(lead, canal, texto, externo_id) {
  try {
    const r = db.prepare('INSERT INTO mensagens (lead_id, direcao, canal, texto, estado, externo_id) VALUES (?,?,?,?,?,?)')
      .run(lead.id, 'inbound', canal, texto, 'recebida', externo_id || null);
    db.prepare('UPDATE leads SET atualizado_em=CURRENT_TIMESTAMP WHERE id=?').run(lead.id);
    return Number(r.lastInsertRowid);
  } catch (e) {
    if (externo_id && /UNIQUE/i.test(e.message)) return null; // mensagem repetida (reenvio do WhatsApp)
    throw e;
  }
}

function valida({ canal, texto }) {
  if (!CANAIS.includes(canal)) throw Object.assign(new Error('Canal inválido'), { status: 400 });
  if (typeof texto !== 'string' || !texto.trim()) throw Object.assign(new Error('Mensagem vazia'), { status: 400 });
  return texto.trim().slice(0, MAX_TEXTO);
}

// Mensagem que não é texto (imagem, áudio…): fica registada e a equipa é avisada, sem rascunho.
export function registarSemResposta({ canal, nome, telefone, texto, externo_id }) {
  const t = valida({ canal, texto });
  const lead = findOrCreateLead({ canal, nome, telefone });
  const id = guardaInbound(lead, canal, t, externo_id);
  if (id == null) return { lead_id: lead.id, duplicada: true };
  db.prepare('UPDATE leads SET alertar=1, resumo_equipa=COALESCE(resumo_equipa, ?) WHERE id=?').run(t, lead.id);
  return { lead_id: lead.id, mensagem_id: id };
}

export async function processInbound({ canal, nome, telefone, texto, lead_id, mota_id, externo_id }) {
  const t = valida({ canal, texto });
  const lead0 = findOrCreateLead({ canal, nome, telefone, lead_id });
  const inboundId = guardaInbound(lead0, canal, t, externo_id);
  if (inboundId == null) return { lead_id: lead0.id, duplicada: true };
  return emFila(lead0.id, () => responder(lead0.id, inboundId, canal, t, mota_id));
}

async function responder(leadId, inboundId, canal, texto, mota_id) {
  const base = { lead_id: leadId, mensagem_id: inboundId };
  const lead = db.prepare('SELECT * FROM leads WHERE id=?').get(leadId);
  if (!lead) return { ...base, erro: 'Lead apagada entretanto' };

  // Se o cliente já escreveu outra mensagem a seguir, a resposta fica para essa (uma só resposta para tudo).
  const ultima = db.prepare("SELECT MAX(id) AS id FROM mensagens WHERE lead_id=? AND direcao='inbound'").get(leadId).id;
  if (ultima > inboundId) return { ...base, adiada: true };

  const mota = mota_id ? getStock().find(m => String(m.id) === String(mota_id)) || null : null;
  const historico = db.prepare("SELECT direcao, texto FROM mensagens WHERE lead_id=? AND id<? AND estado IN ('recebida','enviada') ORDER BY id DESC LIMIT 30")
    .all(leadId, inboundId).reverse();

  let out;
  try { out = await askClaude({ canal, lead, historico, texto, mota }); }
  catch (e) { return { ...base, erro: e.message }; }

  if (!db.prepare('SELECT id FROM leads WHERE id=?').get(leadId)) return { ...base, erro: 'Lead apagada entretanto' };

  const l = out.lead || {};
  const str = (v, n) => (typeof v === 'string' && v.trim() ? v.trim().slice(0, n) : null);
  const telNovo = str(l.telefone, 40);
  db.prepare(`UPDATE leads SET
      nome=COALESCE(?,nome), telefone=COALESCE(telefone,?), telefone_norm=COALESCE(telefone_norm,?),
      mota_interesse=COALESCE(?,mota_interesse), quando_quer_ver=COALESCE(?,quando_quer_ver),
      retoma=?, financiamento=?, classificacao=?, alertar=?, resumo_equipa=?, atualizado_em=CURRENT_TIMESTAMP WHERE id=?`)
    .run(lead.nome ? null : str(l.nome, 120), telNovo, telNovo ? normTel(telNovo) || null : null,
      mota ? [mota.modelo, mota.mes_ano].filter(Boolean).join(' ') : str(l.mota_interesse, 200), str(l.quando_quer_ver, 200),
      (l.retoma || lead.retoma) ? 1 : 0, (l.financiamento || lead.financiamento) ? 1 : 0,
      ['quente', 'morno', 'frio', 'retoma'].includes(l.classificacao) ? l.classificacao : lead.classificacao,
      out.alertar_equipa ? 1 : (lead.alertar ? 1 : 0), str(out.resumo_equipa, 300) || lead.resumo_equipa, leadId);

  let rascunhoId = null, aviso = null;
  const resposta = str(out.resposta_ao_cliente, MAX_TEXTO);
  if (resposta) {
    const final = aplicarAssinatura(resposta, canal);
    aviso = avisosRascunho(final);
    db.exec('BEGIN');
    try {
      // Só fica um rascunho por conversa: o novo substitui os anteriores ainda não enviados.
      db.prepare("UPDATE mensagens SET estado='descartada' WHERE lead_id=? AND estado='rascunho'").run(leadId);
      const r = db.prepare('INSERT INTO mensagens (lead_id, direcao, canal, texto, estado, aviso) VALUES (?,?,?,?,?,?)')
        .run(leadId, 'outbound', canal, final, 'rascunho', aviso);
      rascunhoId = Number(r.lastInsertRowid);
      db.exec('COMMIT');
    } catch (e) { db.exec('ROLLBACK'); throw e; }
  }
  return { ...base, rascunho_id: rascunhoId, alertar_equipa: !!out.alertar_equipa, aviso };
}
