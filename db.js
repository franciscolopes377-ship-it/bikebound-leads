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
CREATE INDEX IF NOT EXISTS idx_msg_lead ON mensagens(lead_id);
`);
