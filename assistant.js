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
  return s.map(m => `- ${m.modelo} | ${m.mes_ano} | ${m.km} km | ${m.preco ? m.preco + ' €' : 'preço n/d'} | ${m.estado} | ${m.link}`).join('\n');
}

const lisbonNow = () => new Intl.DateTimeFormat('pt-PT', {
  timeZone: 'Europe/Lisbon', weekday: 'long', hour: '2-digit', minute: '2-digit', day: '2-digit', month: '2-digit'
}).format(new Date());

export function buildUserContent({ canal, lead, historico, texto }) {
  const h = historico.map(m => `${m.direcao === 'inbound' ? 'CLIENTE' : 'STAND'}: ${m.texto}`).join('\n') || '(primeira mensagem)';
  return `CANAL: ${canal}
HORA LOCAL: ${lisbonNow()}
LEAD ATUAL: ${JSON.stringify({
    nome: lead.nome, telefone: lead.telefone, mota_interesse: lead.mota_interesse,
    quando_quer_ver: lead.quando_quer_ver, retoma: !!lead.retoma, financiamento: !!lead.financiamento,
    classificacao: lead.classificacao
  })}

STOCK:
${stockAsText()}

CONVERSA ATÉ AQUI:
${h}

NOVA MENSAGEM DO CLIENTE:
${texto}`;
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

export async function askClaude(ctx) {
  if (process.env.MOCK_CLAUDE === '1') return mockReply(ctx);
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) throw new Error('Falta ANTHROPIC_API_KEY');
  const r = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: { 'x-api-key': key, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
    body: JSON.stringify({
      model: MODEL, max_tokens: 700, system: SYSTEM_PROMPT,
      messages: [{ role: 'user', content: buildUserContent(ctx) }]
    })
  });
  if (!r.ok) throw new Error(`API Claude ${r.status}: ${(await r.text()).slice(0, 300)}`);
  const data = await r.json();
  return extractJson(data.content.map(c => c.text || '').join(''));
}
