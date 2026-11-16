import { createHash } from 'node:crypto';
import { db, normTel } from './db.js';
import { getStock } from './stock.js';

// Importação de conversas já existentes (por exemplo do OLX). Só regista: não gera rascunhos nem envia nada.
// Pode repetir-se com as mesmas conversas: só entram as mensagens que ainda não existem.

const CANAIS = ['olx', 'whatsapp'];
const CLASSES = ['quente', 'morno', 'frio', 'retoma'];
const ESTADOS = ['novo', 'em_curso', 'visita_marcada', 'vendida', 'perdida'];
const MAX_CONVERSAS = 200, MAX_MENSAGENS = 500;

const str = (v, n) => (typeof v === 'string' && v.trim() ? v.trim().slice(0, n) : null);
const sha = t => createHash('sha256').update(t, 'utf8').digest('hex').slice(0, 20);
const dataSql = d => { if (!d) return null; const t = new Date(d); return Number.isNaN(t.getTime()) ? null : t.toISOString().slice(0, 19).replace('T', ' '); };
const semQuery = l => l.split(/[?#]/)[0].replace(/\/+$/, '').toLowerCase();

function encontraMota(c, stock) {
  if (c.mota_id != null) { const m = stock.find(x => String(x.id) === String(c.mota_id)); if (m) return m; }
  const link = str(c.link_anuncio, 500);
  if (link) { const m = stock.find(x => x.link && semQuery(x.link) === semQuery(link)); if (m) return m; }
  return null;
}

function valida(c) {
  if (!c || typeof c !== 'object') return 'conversa inválida';
  if (!CANAIS.includes(c.canal)) return 'canal inválido';
  if (!Array.isArray(c.mensagens) || !c.mensagens.length) return 'sem mensagens';
  if (c.mensagens.length > MAX_MENSAGENS) return `mais de ${MAX_MENSAGENS} mensagens`;
  for (const m of c.mensagens) {
    if (!m || !['inbound', 'outbound'].includes(m.direcao)) return 'mensagem com direção inválida';
    if (!str(m.texto, 1)) return 'mensagem sem texto';
  }
  if (c.classificacao != null && !CLASSES.includes(c.classificacao)) return 'classificação inválida';
  if (c.estado != null && !ESTADOS.includes(c.estado)) return 'estado inválido';
  return null;
}

export function importarConversas(conversas) {
  if (!Array.isArray(conversas) || !conversas.length) throw Object.assign(new Error('Nada para importar: falta a lista "conversas"'), { status: 400 });
  if (conversas.length > MAX_CONVERSAS) throw Object.assign(new Error(`Máximo de ${MAX_CONVERSAS} conversas por importação`), { status: 400 });
  const stock = getStock();
  const res = { leads_novas: 0, leads_atualizadas: 0, mensagens_novas: 0, conversas_sem_novidades: 0, erros: [] };
  const insMsg = db.prepare('INSERT OR IGNORE INTO mensagens (lead_id, direcao, canal, texto, estado, externo_id, criado_em) VALUES (?,?,?,?,?,?,COALESCE(?, CURRENT_TIMESTAMP))');

  db.exec('BEGIN');
  try {
    conversas.forEach((c, i) => {
      const erro = valida(c);
      if (erro) { res.erros.push({ conversa: i + 1, nome: str(c?.nome, 60), erro }); return; }
      const primeira = c.mensagens[0];
      const ext = 'imp:' + (str(c.externo_id, 200) || sha([c.canal, c.nome, primeira.data, primeira.texto].join('|')));
      const tel = normTel(c.telefone);
      const mota = encontraMota(c, stock);
      const motaTxt = mota ? [mota.modelo, mota.mes_ano].filter(Boolean).join(' ') : str(c.mota, 200);

      let lead = db.prepare('SELECT * FROM leads WHERE externo_id=?').get(ext);
      if (!lead && tel.length >= 9) lead = db.prepare('SELECT * FROM leads WHERE telefone_norm=? ORDER BY id DESC').get(tel);
      const nova = !lead;
      if (nova) {
        const r = db.prepare("INSERT INTO leads (canal, nome, telefone, telefone_norm, externo_id, origem, mota_interesse, criado_em) VALUES (?,?,?,?,?,'importada',?,COALESCE(?, CURRENT_TIMESTAMP))")
          .run(c.canal, str(c.nome, 120), str(c.telefone, 40), tel || null, ext, motaTxt, dataSql(primeira.data));
        lead = db.prepare('SELECT * FROM leads WHERE id=?').get(r.lastInsertRowid);
      }

      let novas = 0, ultima = null;
      for (const m of c.mensagens) {
        const texto = str(m.texto, 4000), data = dataSql(m.data);
        const id = `${ext}:${str(m.externo_id, 100) || sha([m.direcao, m.data || '', texto].join('|'))}`;
        const r = insMsg.run(lead.id, m.direcao, c.canal, texto, m.direcao === 'inbound' ? 'recebida' : 'enviada', id, data);
        if (r.changes) { novas++; if (data && (!ultima || data > ultima)) ultima = data; }
      }

      // Campos opcionais só são gravados quando vêm preenchidos; nunca apagam o que já existe.
      db.prepare(`UPDATE leads SET
          externo_id=COALESCE(externo_id, ?), nome=COALESCE(nome, ?), telefone=COALESCE(telefone, ?), telefone_norm=COALESCE(telefone_norm, ?),
          mota_interesse=COALESCE(?, mota_interesse), classificacao=COALESCE(?, classificacao), estado=COALESCE(?, estado),
          resumo_equipa=COALESCE(?, resumo_equipa), quando_quer_ver=COALESCE(?, quando_quer_ver),
          retoma=MAX(retoma, ?), financiamento=MAX(financiamento, ?),
          atualizado_em=CASE WHEN ? IS NOT NULL AND ? > atualizado_em OR ? = 1 THEN COALESCE(?, atualizado_em) ELSE atualizado_em END
        WHERE id=?`)
        .run(ext, str(c.nome, 120), str(c.telefone, 40), tel || null,
          motaTxt, c.classificacao ?? null, c.estado ?? null, str(c.resumo, 300), str(c.quando_quer_ver, 200),
          c.retoma ? 1 : 0, c.financiamento ? 1 : 0,
          ultima, ultima, nova ? 1 : 0, ultima, lead.id);

      res.mensagens_novas += novas;
      if (nova) res.leads_novas++; else if (novas) res.leads_atualizadas++; else res.conversas_sem_novidades++;
    });
    db.exec('COMMIT');
  } catch (e) { db.exec('ROLLBACK'); throw e; }
  return res;
}
