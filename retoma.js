import { db } from './db.js';
import { getStock } from './stock.js';
import { aplicarAssinatura, saudacaoHora, instrucoesStand, telefoneStand } from './assistant.js';
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

// ---- respostas rápidas (textos do guia) ----
const norm = s => String(s || '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[^a-z0-9]+/g, ' ').trim();
const precoNum = p => Number(String(p || '').replace(/[^\d,]/g, '').split(',')[0]) || null;

// Procura a mensalidade da mota na tabela de financiamento escrita nas instruções ("Modelo (6.950€): 134,86 x 84").
export function simulacao(instrucoes, mota) {
  if (!mota) return null;
  const linhas = String(instrucoes || '').split('\n');
  const alvo = norm(mota.modelo), mat = norm(mota.matricula), preco = precoNum(mota.preco);
  let melhor = null, pont = 0;
  for (const l of linhas) {
    const m = /^(.+?)\(([\d.\s]+)\s*€?\)\s*:\s*([\d.,]+)\s*x\s*(\d+)/i.exec(l.trim());
    if (!m) continue;
    const nome = norm(m[1]);
    let p = 0;
    if (mat && nome.includes(mat)) p += 5;
    if (preco && precoNum(m[2]) === preco) p += 3;
    const pal = alvo.split(' ').filter(w => w.length > 1 && !/^(honda|yamaha|bmw|kawasaki|suzuki|cfmoto|ducati|voge|keeway|benelli|piaggio|mutt|sym|morbidelli|gasgas)$/.test(w));
    if (pal.length && pal.every(w => nome.replace(/\s/g, '').includes(w.replace(/\s/g, '')))) p += 4;
    if (p > pont) { pont = p; melhor = { mensalidade: m[3], meses: m[4] }; }
  }
  return pont >= 4 ? melhor : null;
}

export function textoRapida(lead, tipo, { canal, instrucoes, telefone }) {
  const nossa = motaDoStand(lead);
  const nome = nossa?.modelo || (lead.mota_interesse || '').replace(/\s+\d{2}\/\d{4}$/, '') || 'mota';
  switch (tipo) {
    case 'disponivel': return `Sim, a ${nome} ainda se encontra disponível. Tem interesse em vê-la?`;
    case 'visita': return 'O stand fica na Estrada Vale de Mulatas, Lote 7, Armazém A, Setúbal, e funcionamos com marcação prévia. Qual o dia que lhe seria mais conveniente?';
    case 'garantia': return 'Ao preço a que a mota está anunciada, não vem com garantia.';
    case 'outras': return "Todas as nossas motas estão disponíveis no nosso perfil, em 'Francisco Canelas - BIKEBOUND.'.";
    case 'financiamento': {
      if (/xt\s*600/i.test(nome)) return 'Para esta mota não existe financiamento. Se tiver interesse, podemos vender a pronto pagamento.';
      const s = simulacao(instrucoes, nossa);
      return s ? `Para a ${nome}, a simulação fica em ${s.mensalidade}€ por mês, durante ${s.meses} meses. Fica sujeito a aprovação. Tem interesse?`
        : `Sim, fazemos financiamento, sujeito a aprovação. Pensa dar alguma entrada? Assim conseguimos fazer-lhe uma simulação para a ${nome}.`;
    }
    case 'documentos': {
      const lista = '\n\nCartão de Cidadão/Título de residência\nComprovativo de IBAN\nComprovativo de Morada\n3 últimos recibos de vencimentos\nIRS de 2025\nEmail e Contacto telefónico\n\n';
      const fecho = canal === 'whatsapp' ? 'Pode enviá-los por aqui.' : `Pode enviá-los por WhatsApp para o ${telefone}, indicando o seu nome e a mota.`;
      return `Para avançarmos com o pedido de financiamento, precisamos dos seguintes documentos:${lista}${fecho} Responderemos com a maior brevidade possível acerca dos valores.`;
    }
    default: throw Object.assign(new Error('Resposta rápida desconhecida'), { status: 400 });
  }
}

function abertura(lead, temResposta) {
  const nome = primeiroNome(lead.nome);
  return `${saudacaoHora()}${nome ? ' ' + nome : ''}${temResposta ? ',' : ', como está?'}`;
}

function gravarRascunho(leadId, fazCorpo, extra = '', verificar = true) {
  const lead = db.prepare('SELECT * FROM leads WHERE id=?').get(leadId);
  if (!lead) throw Object.assign(new Error('Lead não encontrada'), { status: 404 });
  const canal = db.prepare("SELECT canal FROM mensagens WHERE lead_id=? AND direcao='inbound' ORDER BY criado_em DESC, id DESC LIMIT 1").get(leadId)?.canal || lead.canal;
  const temResposta = !!db.prepare("SELECT 1 FROM mensagens WHERE lead_id=? AND direcao='outbound' AND estado='enviada'").get(leadId);
  const texto = aplicarAssinatura(`${abertura(lead, temResposta)}\n\n${fazCorpo(lead, canal)}`, canal);
  // Valores escritos pela equipa (proposta de retoma) não precisam de aviso.
  const aviso = verificar ? avisosRascunho(texto) : null;
  let id;
  db.exec('BEGIN');
  try {
    db.prepare("UPDATE mensagens SET estado='descartada' WHERE lead_id=? AND estado='rascunho'").run(leadId);
    id = Number(db.prepare('INSERT INTO mensagens (lead_id, direcao, canal, texto, estado, aviso) VALUES (?,?,?,?,?,?)').run(leadId, 'outbound', canal, texto, 'rascunho', aviso).lastInsertRowid);
    db.prepare(`UPDATE leads SET ${extra} estado=CASE WHEN estado='novo' THEN 'em_curso' ELSE estado END, atualizado_em=CURRENT_TIMESTAMP WHERE id=?`).run(leadId);
    db.exec('COMMIT');
  } catch (e) { db.exec('ROLLBACK'); throw e; }
  return { rascunho_id: id, texto };
}

export function prepararRapida(leadId, tipo) {
  return gravarRascunho(leadId, (lead, canal) => textoRapida(lead, tipo, { canal, instrucoes: instrucoesStand(), telefone: telefoneStand() }));
}

export function prepararRetoma(leadId, opcoes) {
  return gravarRascunho(leadId, lead => textoRetoma(lead, opcoes, true).split('\n\n').slice(1).join('\n\n'), "retoma=1, classificacao='retoma', alertar=0,", false);
}
