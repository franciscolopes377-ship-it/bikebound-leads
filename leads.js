import { db } from './db.js';
import { askClaude } from './assistant.js';
import { getStock } from './stock.js';

export function findOrCreateLead({ canal, nome, telefone, lead_id }) {
  if (lead_id) {
    const l = db.prepare('SELECT * FROM leads WHERE id=?').get(lead_id);
    if (l) return l;
  }
  let l;
  if (telefone) l = db.prepare('SELECT * FROM leads WHERE telefone=? ORDER BY id DESC').get(telefone);
  if (!l && nome) l = db.prepare('SELECT * FROM leads WHERE canal=? AND nome=? ORDER BY id DESC').get(canal, nome);
  if (l) return l;
  const r = db.prepare('INSERT INTO leads (canal, nome, telefone) VALUES (?,?,?)').run(canal, nome || null, telefone || null);
  return db.prepare('SELECT * FROM leads WHERE id=?').get(r.lastInsertRowid);
}

export async function processInbound({ canal, nome, telefone, texto, lead_id, mota_id }) {
  if (!texto || !texto.trim()) throw new Error('Mensagem vazia');
  if (!['whatsapp', 'olx'].includes(canal)) throw new Error('Canal inválido');
  const lead = findOrCreateLead({ canal, nome, telefone, lead_id });
  const mota = mota_id ? getStock().find(m => String(m.id) === String(mota_id)) || null : null;
  const historico = db.prepare('SELECT direcao, texto FROM mensagens WHERE lead_id=? AND estado IN (\'recebida\',\'enviada\') ORDER BY id').all(lead.id);
  const inbound = db.prepare('INSERT INTO mensagens (lead_id, direcao, canal, texto, estado) VALUES (?,?,?,?,?)')
    .run(lead.id, 'inbound', canal, texto.trim(), 'recebida');

  let out, erro = null;
  try { out = await askClaude({ canal, lead, historico, texto: texto.trim(), mota }); }
  catch (e) { erro = e.message; }

  if (erro) {
    db.prepare('UPDATE leads SET atualizado_em=CURRENT_TIMESTAMP WHERE id=?').run(lead.id);
    return { lead_id: lead.id, mensagem_id: Number(inbound.lastInsertRowid), erro };
  }

  const l = out.lead || {};
  db.prepare(`UPDATE leads SET
      nome=COALESCE(?,nome), telefone=COALESCE(?,telefone), mota_interesse=COALESCE(?,mota_interesse),
      quando_quer_ver=COALESCE(?,quando_quer_ver), retoma=?, financiamento=?, classificacao=?,
      alertar=?, resumo_equipa=?, atualizado_em=CURRENT_TIMESTAMP WHERE id=?`)
    .run(l.nome ?? null, l.telefone ?? null, l.mota_interesse ?? null, l.quando_quer_ver ?? null,
      (l.retoma || lead.retoma) ? 1 : 0, (l.financiamento || lead.financiamento) ? 1 : 0,
      ['quente', 'morno', 'frio', 'retoma'].includes(l.classificacao) ? l.classificacao : lead.classificacao,
      out.alertar_equipa ? 1 : (lead.alertar ? 1 : 0), out.resumo_equipa || lead.resumo_equipa, lead.id);

  if (mota) db.prepare('UPDATE leads SET mota_interesse=? WHERE id=?').run([mota.modelo, mota.mes_ano].filter(Boolean).join(' '), lead.id);

  let rascunhoId = null;
  if (out.resposta_ao_cliente) {
    const r = db.prepare('INSERT INTO mensagens (lead_id, direcao, canal, texto, estado) VALUES (?,?,?,?,?)')
      .run(lead.id, 'outbound', canal, out.resposta_ao_cliente, 'rascunho');
    rascunhoId = Number(r.lastInsertRowid);
  }
  return { lead_id: lead.id, mensagem_id: Number(inbound.lastInsertRowid), rascunho_id: rascunhoId, alertar_equipa: !!out.alertar_equipa };
}
