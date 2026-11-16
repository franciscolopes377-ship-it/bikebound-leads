import { db } from './db.js';

// CSV simples: separador ; ou , (detetado), aspas suportadas.
export function parseCsv(text) {
  const clean = text.replace(/^﻿/, '').replace(/\r/g, '');
  const firstLine = clean.split('\n')[0] || '';
  const sep = (firstLine.match(/;/g) || []).length >= (firstLine.match(/,/g) || []).length ? ';' : ',';
  const rows = []; let row = [], cur = '', q = false;
  for (let i = 0; i < clean.length; i++) {
    const c = clean[i];
    if (q) {
      if (c === '"' && clean[i + 1] === '"') { cur += '"'; i++; }
      else if (c === '"') q = false;
      else cur += c;
    } else if (c === '"') q = true;
    else if (c === sep) { row.push(cur); cur = ''; }
    else if (c === '\n') { row.push(cur); rows.push(row); row = []; cur = ''; }
    else cur += c;
  }
  if (cur !== '' || row.length) { row.push(cur); rows.push(row); }
  return rows.filter(r => r.some(x => x.trim() !== ''));
}

const norm = s => s.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z]/g, '');
const ALIASES = {
  modelo: ['modelo', 'mota', 'marcaemodelo', 'descricao'],
  mes_ano: ['mesano', 'ano', 'matricula', 'registo', 'datadematricula'],
  km: ['km', 'kms', 'quilometros', 'quilometragem'],
  preco: ['preco', 'precodevenda', 'pvp', 'valor'],
  estado: ['estado', 'estadogeral'],
  link: ['link', 'url', 'anuncio', 'fotos']
};

export function importStock(csvText) {
  const rows = parseCsv(csvText);
  if (rows.length < 2) throw new Error('CSV vazio ou sem linhas de dados');
  const head = rows[0].map(norm);
  const idx = {};
  for (const [campo, nomes] of Object.entries(ALIASES)) idx[campo] = head.findIndex(h => nomes.includes(h));
  if (idx.modelo < 0) throw new Error('Falta a coluna "modelo" (ou "mota")');
  db.exec('BEGIN');
  try {
    db.exec('DELETE FROM stock');
    const ins = db.prepare('INSERT INTO stock (modelo, mes_ano, km, preco, estado, link) VALUES (?,?,?,?,?,?)');
    let n = 0;
    for (const r of rows.slice(1)) {
      const g = k => (idx[k] >= 0 ? (r[idx[k]] || '').trim() : '');
      if (!g('modelo')) continue;
      ins.run(g('modelo'), g('mes_ano'), g('km'), g('preco'), g('estado'), g('link'));
      n++;
    }
    db.exec('COMMIT');
    return n;
  } catch (e) { db.exec('ROLLBACK'); throw e; }
}

export const getStock = () => db.prepare('SELECT * FROM stock ORDER BY id').all();
