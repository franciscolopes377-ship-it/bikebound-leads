import { getStock } from './stock.js';

// Só os dígitos da parte inteira: "7.900 €", "7 900" e "7900,00" → "7900".
export function precoNorm(p) {
  let s = String(p || '').trim();
  if (/^\d+\.\d{1,2}$/.test(s)) s = s.replace('.', ','); // "7900.5" é decimal; "7.900" é milhar
  return s.replace(/[^\d,]/g, '').split(',')[0].replace(/^0+/, '');
}

const RE_PRECO = /(\d{1,3}(?:[.\s ]\d{3})+|\d+)(?:,\d{1,2})?\s*(?:€|eur\b|euros?\b)/gi;
const RE_LINK = /https?:\/\/[^\s)>\]]+/gi;

// Verifica o rascunho contra o stock. Devolve avisos para a equipa (ou null).
export function avisosRascunho(texto) {
  if (!texto) return null;
  const stock = getStock();
  const precos = new Set(stock.map(m => precoNorm(m.preco)).filter(Boolean));
  const links = new Set(stock.map(m => (m.link || '').trim().replace(/[.,;]+$/, '')).filter(Boolean));
  const avisos = [];
  for (const m of texto.matchAll(RE_PRECO)) {
    const n = precoNorm(m[1]);
    if (n && !precos.has(n)) avisos.push(`O valor "${m[0].trim()}" não corresponde a nenhum preço do stock.`);
  }
  for (const m of texto.matchAll(RE_LINK)) {
    const l = m[0].replace(/[.,;]+$/, '');
    if (!links.has(l)) avisos.push(`O link ${l} não consta do stock.`);
  }
  return avisos.length ? [...new Set(avisos)].join(' ') : null;
}
