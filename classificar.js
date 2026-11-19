// Classificação inicial de conversas importadas (palavras-chave). As mensagens novas são classificadas pelo assistente.
const RET = /retoma|\btroca|trocar|dar a minha|dar a mota|aceita(m)? (a )?(minha|o meu|carro|mota)|meu carro|minha mota como/i;
const FIN = /financ|presta[çc]|mensalidade|cr[ée]dito/i;
const QUENTE = /financ|visitar|ver a mota|ir ver|ir a[ií]|marcar|s[áa]bado|domingo|amanh[ãa]|reserv|sinal|fechar neg[óo]cio|ainda hoje|esta semana|test(e|ar) drive|experimentar/i;
const MORNO = /pre[çc]o|m[íi]nimo|desconto|valor|\bkm|quil[óo]metr|revis|dispon[íi]vel|ainda (est[áa]|tem)|negoci|garantia|entrega|transporte|portes/i;
const PERD = /n[ãa]o tenho interesse|sem interesse|j[áa] comprei|desist|fica fora do meu or[çc]amento|n[ãa]o me interessa/i;

export function classificarConversa(mensagens) {
  const ins = mensagens.filter(m => m.direcao === 'inbound').map(m => m.texto).join('\n');
  const ultimoIn = [...mensagens].reverse().find(m => m.direcao === 'inbound')?.texto || '';
  const retoma = RET.test(ins), financiamento = FIN.test(ins);
  let classificacao = retoma ? 'retoma' : QUENTE.test(ins) ? 'quente' : MORNO.test(ins) ? 'morno' : 'frio';
  let estado = mensagens.some(m => m.direcao === 'outbound') ? 'em_curso' : 'novo';
  if (PERD.test(ultimoIn)) { estado = 'perdida'; if (classificacao !== 'retoma') classificacao = 'frio'; }
  return { classificacao, estado, retoma, financiamento };
}
