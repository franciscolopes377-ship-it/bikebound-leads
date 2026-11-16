import { db } from './db.js';

const configurado = () => !!(process.env.BIKEBOUND_STOCK_URL && process.env.BIKEBOUND_STOCK_TOKEN);

export function syncStatus() {
  const i = db.prepare('SELECT * FROM sync_info WHERE id=1').get() || {};
  return {
    configurado: configurado(),
    ultima_ok: i.ultima_ok || null, ultima_tentativa: i.ultima_tentativa || null,
    motas: i.n ?? 0, erro: i.erro || null
  };
}

const guardaInfo = (ok, n, erro) => db.prepare(`INSERT INTO sync_info (id, ultima_ok, ultima_tentativa, n, erro) VALUES (1,?,?,?,?)
  ON CONFLICT(id) DO UPDATE SET ultima_ok=COALESCE(excluded.ultima_ok, ultima_ok), ultima_tentativa=excluded.ultima_tentativa,
  n=COALESCE(excluded.n, n), erro=excluded.erro`).run(ok ? new Date().toISOString() : null, new Date().toISOString(), ok ? n : null, erro || null);

// Lê o stock da BikeBound e substitui o stock sincronizado. Em caso de falha mantém o anterior.
export async function syncStock({ fetchImpl = fetch } = {}) {
  try {
    if (!configurado()) throw new Error('Falta BIKEBOUND_STOCK_URL / BIKEBOUND_STOCK_TOKEN');
    const r = await fetchImpl(process.env.BIKEBOUND_STOCK_URL, {
      headers: { authorization: `Bearer ${process.env.BIKEBOUND_STOCK_TOKEN}` },
      signal: AbortSignal.timeout(20000)
    });
    if (!r.ok) throw new Error(`BikeBound respondeu ${r.status}`);
    const data = await r.json();
    if (!data || !Array.isArray(data.motas)) throw new Error('Resposta da BikeBound inválida');
    const atual = db.prepare('SELECT COUNT(*) AS n FROM stock_sync').get().n;
    if (data.motas.length === 0 && atual > 0) throw new Error('A BikeBound devolveu 0 motas; stock anterior mantido');
    db.exec('BEGIN');
    try {
      db.exec('DELETE FROM stock_sync');
      const ins = db.prepare('INSERT OR REPLACE INTO stock_sync (matricula, marca, modelo, versao, cilindrada, cor, km, data_matricula, ano, dias_em_stock, preco, link) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)');
      const preco = m => { const v = m.preco_anunciado ?? m.preco_venda ?? null; const n = Number(v); if (v == null || v === '' || !Number.isFinite(n) || n <= 0) return null; return Number.isInteger(n) ? String(n) : n.toFixed(2).replace('.', ','); };
      const link = m => (typeof m.link_anuncio === 'string' && /^https:\/\//.test(m.link_anuncio.trim()) ? m.link_anuncio.trim() : null);
      for (const m of data.motas) {
        if (!m.matricula) continue;
        ins.run(m.matricula, m.marca ?? null, m.modelo ?? null, m.versao ?? null, m.cilindrada ?? null, m.cor ?? null,
          m.quilometragem ?? null, m.data_matricula ?? null, m.ano ?? null, m.dias_em_stock ?? null, preco(m), link(m));
      }
      db.exec('COMMIT');
    } catch (e) { db.exec('ROLLBACK'); throw e; }
    const n = db.prepare('SELECT COUNT(*) AS n FROM stock_sync').get().n;
    guardaInfo(true, n, null);
    return { motas: n };
  } catch (e) {
    guardaInfo(false, null, e.message);
    throw e;
  }
}

export function startAutoSync(horas = 1) {
  if (!configurado()) return;
  const corre = () => syncStock().catch(e => console.error('sync stock:', e.message));
  corre();
  setInterval(corre, horas * 3600 * 1000);
}
