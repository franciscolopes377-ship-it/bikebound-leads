import { db } from './db.js';
import { getStock } from './stock.js';
import { aplicarAssinatura, saudacaoHora } from './assistant.js';
import { avisosRascunho } from './guard.js';

// Respostas de retoma escolhidas pela equipa (textos do guia). Não chamam o Claude.
const BAIXO_VALOR = /xt\s*600|x\s*max|cbr\s*250|cb\s*125/i; // nestas, a recusa não oferece financiamento
const euros = v => String(Math.round(v)).replace(/\B(?=(\d{3})+(?!\d))/g, '.') + '€';
const primeiroNome = n => (/^[A-ZÀ-Ý][a-zà-ÿ]+(?: [A-ZÀ-Ý][a-zà-ÿ'-]+)*$/.test(String(n || '').trim()) ? String(n).trim().split(' ')[0] : null);
const numero = v => { const n = Number(String(v ?? '').replace(/[^\d,.-]/g, '').replace(/\.(?=\d{3}(\D|$))/g, '').replace(',', '.')); return Number.isFinite(n) && n > 0 ? n : null; };

function motaDoStand(lead) {
  if (!lead.mota_interesse) return null;
  return getStock().find(m => [m.modelo, m.mes_ano].filter(Boolean).join(' ') === lead.mota_interesse) || null;
}

export function textoRetoma(lead, { acao, valor, mota_cliente, preco }, temResposta) {
  const nossa = motaDoStand(lead);
  const nomeNossa = nossa?.modelo || (lead.mota_interesse || '').replace(/\s+\d{2}\/\d{4}$/, '') || 'nossa mota';
  const sua = String(mota_cliente || '').trim() ? `sua ${String(mota_cliente).trim()}` : 'sua mota';
  let corpo;
  if (acao === 'anunciada') corpo = 'A mota que pretende dar em troca é a que se encontra anunciada no seu perfil?';
  else if (acao === 'dados') corpo = `Podemos avaliar a ${sua}. Pode enviar-nos o ano, os quilómetros, o estado geral e algumas fotografias?`;
  else if (acao === 'recusar') {
    corpo = BAIXO_VALOR.test(nomeNossa)
      ? `Lamento, mas não temos interesse na aquisição da sua mota. Se tiver interesse, podemos vender a ${nomeNossa} a pronto pagamento.`
      : `Lamento, mas não temos interesse na aquisição da sua mota. Se tiver interesse, podemos vender a ${nomeNossa} a pronto pagamento ou então oferecer-lhe a possibilidade de financiamento.`;
  } else if (acao === 'proposta') {
    const x = numero(valor);
    if (!x) throw Object.assign(new Error('Indica o valor da retoma'), { status: 400 });
    const p = numero(preco) ?? numero(nossa?.preco);
    if (!p) throw Object.assign(new Error('Falta o preço anunciado da nossa mota'), { status: 400 });
    const y = p - x;
    corpo = y > 0 ? `Podemos retomar a ${sua} por ${euros(x)}, ficando um acerto de ${euros(y)} da sua parte para a nossa ${nomeNossa}. Faz sentido para si?`
      : y < 0 ? `Podemos retomar a ${sua} por ${euros(x)}. Ficando com a nossa ${nomeNossa}, o acerto seria de ${euros(-y)} da nossa parte. Faz sentido para si?`
      : `Podemos retomar a ${sua} por ${euros(x)}, ficando a troca direta pela nossa ${nomeNossa}, sem acerto. Faz sentido para si?`;
  } else throw Object.assign(new Error('Ação inválida'), { status: 400 });
  const nome = primeiroNome(lead.nome);
  const abertura = `${saudacaoHora()}${nome ? ' ' + nome : ''}${temResposta ? ',' : ', como está?'}`;
  return `${abertura}\n\n${corpo}`;
}

export function prepararRetoma(leadId, opcoes) {
  const lead = db.prepare('SELECT * FROM leads WHERE id=?').get(leadId);
  if (!lead) throw Object.assign(new Error('Lead não encontrada'), { status: 404 });
  const canal = db.prepare("SELECT canal FROM mensagens WHERE lead_id=? AND direcao='inbound' ORDER BY criado_em DESC, id DESC LIMIT 1").get(leadId)?.canal || lead.canal;
  const temResposta = !!db.prepare("SELECT 1 FROM mensagens WHERE lead_id=? AND direcao='outbound' AND estado='enviada'").get(leadId);
  const texto = aplicarAssinatura(textoRetoma(lead, opcoes, temResposta), canal);
  const aviso = avisosRascunho(texto);
  let id;
  db.exec('BEGIN');
  try {
    db.prepare("UPDATE mensagens SET estado='descartada' WHERE lead_id=? AND estado='rascunho'").run(leadId);
    id = Number(db.prepare('INSERT INTO mensagens (lead_id, direcao, canal, texto, estado, aviso) VALUES (?,?,?,?,?,?)').run(leadId, 'outbound', canal, texto, 'rascunho', aviso).lastInsertRowid);
    db.prepare("UPDATE leads SET retoma=1, classificacao='retoma', alertar=0, estado=CASE WHEN estado='novo' THEN 'em_curso' ELSE estado END, atualizado_em=CURRENT_TIMESTAMP WHERE id=?").run(leadId);
    db.exec('COMMIT');
  } catch (e) { db.exec('ROLLBACK'); throw e; }
  return { rascunho_id: id, texto };
}
