import { getStock } from './stock.js';

const MODEL = process.env.CLAUDE_MODEL || 'claude-haiku-5-5';

export const SYSTEM_PROMPT = `És o assistente de vendas da BIKEBOUND, stand de motas usadas em Setúbal. Falas português de Portugal, mensagens curtas (máx. 4 linhas), simpáticas e diretas, sem tom de robô.

FORMATO DE CADA RESPOSTA
- Abre com "Bom dia/Boa tarde, como está?" (conforme a hora indicada) só na primeira mensagem da conversa.
- Termina sempre com uma pergunta.
- Em OLX, assina: "Melhores cumprimentos, Francisco Canelas, 916808800, BIKEBOUND". No WhatsApp, não repitas a assinatura.

DADOS
Só usas a lista de stock que recebes (modelo, mês/ano, km, preço de venda, estado, link). Nunca inventes dados. Se o preço não constar, não o indiques e diz que a equipa confirma.

COMO RESPONDER
- Se receberes "MOTA EM CAUSA", o cliente refere-se a essa mota (vem do anúncio): responde sobre ela.
- Pergunta por mota do stock: confirma disponibilidade, mês/ano, km e preço de venda.
- Mota vendida ou não encontrada: diz com franqueza. Não sugiras motas; o cliente vê o perfil do stand no OLX.
- Visita: o stand funciona por marcação prévia. Pergunta que dia e hora lhe dá jeito.
- Transporte: o stand faz entrega, com ajuste de preço. Diz que a equipa confirma o valor.
- Financiamento: pede que envie os documentos por WhatsApp para 916808800, indicando o nome e a mota.
- Negociação de preço: não negoceies nem prometas desconto. Diz que a equipa fala com ele.

NUNCA
- Respondas a retomas nem dês valor de retoma. Marca como "retoma" e devolve resposta_ao_cliente = null.
- Confirmes financiamento ou condições, nem peças NIF, cartão ou documentos pessoais.
- Prometas disponibilidade futura ou reservas.

CLASSIFICAÇÃO
- quente: quer visitar em dia concreto, pergunta por reserva, sinal ou financiamento.
- morno: pergunta por preço ou detalhes de uma mota, sem data.
- frio: pergunta genérica.
- retoma: menciona dar uma mota como parte de pagamento.

SAÍDA: responde APENAS com JSON válido, sem texto à volta:
{
  "resposta_ao_cliente": "texto ou null se retoma",
  "lead": {
    "nome": null, "telefone": null,
    "mota_interesse": null, "quando_quer_ver": null,
    "retoma": false, "financiamento": false,
    "classificacao": "quente|morno|frio|retoma"
  },
  "alertar_equipa": true,
  "resumo_equipa": "uma linha: cliente, mota, o que quer, quando"
}
alertar_equipa = true para quente, para retoma e para pedido de falar com uma pessoa.
Mantém os valores já conhecidos do lead se a nova mensagem não os alterar.`;

function stockAsText() {
  const s = getStock();
  if (!s.length) return '(stock vazio)';
  return s.map(m => `- ${[m.modelo, m.mes_ano, m.km && m.km + ' km', m.cor, m.preco ? m.preco + ' €' : 'preço n/d', m.estado, m.link].filter(Boolean).join(' | ')}`).join('\n');
}

const lisbonNow = () => new Intl.DateTimeFormat('pt-PT', {
  timeZone: 'Europe/Lisbon', weekday: 'long', hour: '2-digit', minute: '2-digit', day: '2-digit', month: '2-digit'
}).format(new Date());

export function buildUserContent({ canal, lead, historico, texto, mota }) {
  const h = historico.map(m => `${m.direcao === 'inbound' ? 'CLIENTE' : 'STAND'}: ${m.texto}`).join('\n') || '(primeira mensagem)';
  return `CANAL: ${canal}
HORA LOCAL: ${lisbonNow()}
LEAD ATUAL: ${JSON.stringify({
    nome: lead.nome, telefone: lead.telefone, mota_interesse: lead.mota_interesse,
    quando_quer_ver: lead.quando_quer_ver, retoma: !!lead.retoma, financiamento: !!lead.financiamento,
    classificacao: lead.classificacao
  })}

${mota ? `MOTA EM CAUSA: ${[mota.modelo, mota.mes_ano, mota.km && mota.km + ' km', mota.preco ? mota.preco + ' €' : 'preço n/d', mota.link].filter(Boolean).join(' | ')}\n\n` : ''}STOCK:
${stockAsText()}

CONVERSA ATÉ AQUI:
${h}

NOVA MENSAGEM DO CLIENTE:
${texto}

IMPORTANTE: não respondas ao cliente diretamente. Devolve APENAS o objeto JSON descrito no sistema (começa em { e termina em }), com a resposta ao cliente dentro de "resposta_ao_cliente".`;
}

export function extractJson(text) {
  const a = text.indexOf('{'), b = text.lastIndexOf('}');
  if (a < 0 || b < 0) throw new Error('Resposta sem JSON');
  return JSON.parse(text.slice(a, b + 1));
}

function mockReply({ texto, canal }) {
  const t = texto.toLowerCase();
  const retoma = /retoma|troca|dar a minha/.test(t);
  const quente = /s[áa]bado|amanh[ãa]|visitar|ver a mota|sinal|reserv|financ/.test(t);
  return {
    resposta_ao_cliente: retoma ? null :
      `Boa tarde, como está? [MOCK] A mota ainda está disponível. Que dia lhe dá jeito para marcar visita?${canal === 'olx' ? '\nMelhores cumprimentos, Francisco Canelas, 916808800, BIKEBOUND' : ''}`,
    lead: { nome: null, telefone: null, mota_interesse: null, quando_quer_ver: quente ? 'a combinar' : null,
      retoma, financiamento: /financ/.test(t), classificacao: retoma ? 'retoma' : quente ? 'quente' : 'morno' },
    alertar_equipa: retoma || quente,
    resumo_equipa: `[MOCK] ${texto.slice(0, 80)}`
  };
}

async function callApi(key, messages) {
  const r = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: { 'x-api-key': key, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
    body: JSON.stringify({ model: MODEL, max_tokens: 900, system: SYSTEM_PROMPT, messages })
  });
  if (!r.ok) throw new Error(`API Claude ${r.status}: ${(await r.text()).slice(0, 300)}`);
  const data = await r.json();
  const text = (data.content || []).map(c => c.text || '').join('');
  return { text, stop: data.stop_reason };
}

export async function askClaude(ctx) {
  if (process.env.MOCK_CLAUDE === '1') return mockReply(ctx);
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) throw new Error('Falta ANTHROPIC_API_KEY');
  const user = buildUserContent(ctx);
  let { text, stop } = await callApi(key, [{ role: 'user', content: user }]);
  try { return extractJson(text); } catch { /* segunda tentativa abaixo */ }
  // Segunda tentativa: pede explicitamente o JSON e deixa o modelo corrigir a resposta anterior
  const retry = await callApi(key, [
    { role: 'user', content: user },
    { role: 'assistant', content: text && text.trim() ? text : '(sem resposta)' },
    { role: 'user', content: 'Devolve agora a mesma resposta, mas APENAS como o objeto JSON pedido (começa em { e termina em }), sem texto antes ou depois.' }
  ]);
  try { return extractJson(retry.text); }
  catch {
    const excerto = (retry.text || text || '(vazio)').replace(/\s+/g, ' ').slice(0, 200);
    throw new Error(`Resposta sem JSON (motivo: ${retry.stop || stop}). Início da resposta: "${excerto}"`);
  }
}
