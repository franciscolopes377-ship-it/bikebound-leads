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

export const normMat = m => String(m || '').toUpperCase().replace(/[^A-Z0-9]/g, '');

const PRECO_ALIASES = {
  matricula: ['matricula', 'mat'],
  preco: ['preco', 'precodevenda', 'pvp', 'valor'],
  estado: ['estado', 'estadogeral'],
  link: ['link', 'url', 'anuncio']
};

// CSV de preços e links por matrícula. Substitui a tabela anterior.
export function importPrecos(csvText) {
  const rows = parseCsv(csvText);
  if (rows.length < 2) throw new Error('CSV vazio ou sem linhas de dados');
  const head = rows[0].map(norm);
  const idx = {};
  for (const [campo, nomes] of Object.entries(PRECO_ALIASES)) idx[campo] = head.findIndex(h => nomes.includes(h));
  if (idx.matricula < 0) throw new Error('Falta a coluna "matricula"');
  if (idx.preco < 0 && idx.link < 0) throw new Error('Falta a coluna "preco" ou "link"');
  db.exec('BEGIN');
  try {
    db.exec('DELETE FROM precos');
    const ins = db.prepare('INSERT OR REPLACE INTO precos (matricula, preco, link, estado) VALUES (?,?,?,?)');
    let n = 0;
    for (const r of rows.slice(1)) {
      const g = k => (idx[k] >= 0 ? (r[idx[k]] || '').trim() : '');
      const m = normMat(g('matricula'));
      if (!m) continue;
      ins.run(m, g('preco'), g('link'), g('estado'));
      n++;
    }
    db.exec('COMMIT');
    return n;
  } catch (e) { db.exec('ROLLBACK'); throw e; }
}

const mesAno = (data, ano) => {
  const m = /^(\d{4})-(\d{2})/.exec(data || '');
  return m ? `${m[2]}/${m[1]}` : (ano ? String(ano) : '');
};

// Stock usado pelo assistente: se existir sincronização com a BikeBound usa-a (com preço/link por matrícula);
// caso contrário usa o CSV carregado à mão.
export function getStock() {
  const sync = db.prepare('SELECT * FROM stock_sync ORDER BY marca, modelo, matricula').all();
  if (!sync.length) return db.prepare('SELECT * FROM stock ORDER BY id').all().map(m => ({ ...m, id: String(m.id), fonte: 'csv', sem_preco: !m.preco }));
  const precos = new Map(db.prepare('SELECT * FROM precos').all().map(p => [p.matricula, p]));
  return sync.map(m => {
    const p = precos.get(normMat(m.matricula)) || {};
    return {
      id: m.matricula,
      matricula: m.matricula,
      modelo: [m.marca, m.modelo, m.versao].filter(Boolean).join(' '),
      mes_ano: mesAno(m.data_matricula, m.ano),
      km: m.km != null ? String(m.km) : '',
      cor: m.cor || '',
      cilindrada: m.cilindrada || '',
      preco: p.preco || '',
      estado: p.estado || '',
      link: p.link || '',
      fonte: 'bikebound',
      sem_preco: !p.preco
    };
  });
}
