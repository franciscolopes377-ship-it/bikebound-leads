import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

const path = process.env.DB_PATH || './data/leads.db';
mkdirSync(dirname(path), { recursive: true });
export const db = new DatabaseSync(path);

db.exec(`
PRAGMA journal_mode = WAL;
CREATE TABLE IF NOT EXISTS leads (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  nome TEXT, telefone TEXT, canal TEXT NOT NULL,
  mota_interesse TEXT, quando_quer_ver TEXT,
  retoma INTEGER DEFAULT 0, financiamento INTEGER DEFAULT 0,
  classificacao TEXT DEFAULT 'frio',
  estado TEXT DEFAULT 'novo',
  alertar INTEGER DEFAULT 0, resumo_equipa TEXT,
  criado_em TEXT DEFAULT CURRENT_TIMESTAMP,
  atualizado_em TEXT DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS mensagens (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  lead_id INTEGER NOT NULL REFERENCES leads(id),
  direcao TEXT NOT NULL,          -- inbound | outbound
  canal TEXT NOT NULL,
  texto TEXT,
  estado TEXT DEFAULT 'recebida', -- recebida | rascunho | enviada | descartada
  criado_em TEXT DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS stock (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  modelo TEXT, mes_ano TEXT, km TEXT, preco TEXT, estado TEXT, link TEXT
);
CREATE TABLE IF NOT EXISTS stock_sync (
  matricula TEXT PRIMARY KEY, marca TEXT, modelo TEXT, versao TEXT, cilindrada INTEGER, cor TEXT,
  km INTEGER, data_matricula TEXT, ano INTEGER, dias_em_stock INTEGER
);
CREATE TABLE IF NOT EXISTS precos (matricula TEXT PRIMARY KEY, preco TEXT, link TEXT, estado TEXT);
CREATE TABLE IF NOT EXISTS sync_info (
  id INTEGER PRIMARY KEY CHECK (id = 1), ultima_ok TEXT, ultima_tentativa TEXT, n INTEGER, erro TEXT
);
CREATE TABLE IF NOT EXISTS config (chave TEXT PRIMARY KEY, valor TEXT);
CREATE INDEX IF NOT EXISTS idx_msg_lead ON mensagens(lead_id);
`);

// --- migrações: acrescenta colunas novas a bases de dados já existentes ---
const colunas = t => db.prepare(`PRAGMA table_info(${t})`).all().map(c => c.name);
const addCol = (t, c, tipo) => { if (!colunas(t).includes(c)) db.exec(`ALTER TABLE ${t} ADD COLUMN ${c} ${tipo}`); };
addCol('mensagens', 'externo_id', 'TEXT');      // id da mensagem no WhatsApp (evita duplicados)
addCol('mensagens', 'aviso', 'TEXT');           // avisos automáticos sobre o rascunho
addCol('mensagens', 'texto_original', 'TEXT');  // rascunho antes de ser editado pela equipa
addCol('leads', 'telefone_norm', 'TEXT');
addCol('leads', 'externo_id', 'TEXT');           // id da conversa de origem (importações)
addCol('leads', 'origem', 'TEXT');               // 'importada' quando veio de uma importação
addCol('stock_sync', 'preco', 'TEXT');           // preço anunciado vindo da BikeBound
addCol('stock_sync', 'link', 'TEXT');            // link do anúncio vindo da BikeBound
db.exec(`
CREATE UNIQUE INDEX IF NOT EXISTS idx_msg_externo ON mensagens(externo_id) WHERE externo_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_lead_tel ON leads(telefone_norm);
CREATE UNIQUE INDEX IF NOT EXISTS idx_lead_externo ON leads(externo_id) WHERE externo_id IS NOT NULL;
`);

// Telefone só com dígitos, sem indicativo de Portugal: "+351 912 345 678" e "912345678" são o mesmo cliente.
export function normTel(t) {
  let d = String(t || '').replace(/\D/g, '').replace(/^00/, '');
  if (d.length === 12 && d.startsWith('351')) d = d.slice(3);
  return d;
}
for (const l of db.prepare("SELECT id, telefone FROM leads WHERE telefone IS NOT NULL AND telefone_norm IS NULL").all()) {
  db.prepare('UPDATE leads SET telefone_norm=? WHERE id=?').run(normTel(l.telefone) || null, l.id);
}

export const getConfig = chave => db.prepare('SELECT valor FROM config WHERE chave=?').get(chave)?.valor ?? null;
export const setConfig = (chave, valor) => db.prepare('INSERT INTO config (chave, valor) VALUES (?,?) ON CONFLICT(chave) DO UPDATE SET valor=excluded.valor').run(chave, valor);

