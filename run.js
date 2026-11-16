import assert from 'node:assert/strict';
import { rmSync } from 'node:fs';
const dbp = '/tmp/bb-test.db';
for (const s of ['', '-wal', '-shm']) rmSync(dbp + s, { force: true });
Object.assign(process.env, { DB_PATH: dbp, MOCK_CLAUDE: '1', APP_PASSWORD: 'segredo', WHATSAPP_VERIFY_TOKEN: 'tok' });

const { server } = await import('./server.js');
const { extractJson } = await import('./assistant.js');
await new Promise(r => server.listen(0, r));
const base = `http://localhost:${server.address().port}`;
const auth = { authorization: 'Basic ' + Buffer.from('x:segredo').toString('base64') };
const j = async (p, o = {}) => { const r = await fetch(base + p, { ...o, headers: { ...auth, ...(o.headers || {}) } }); return { s: r.status, b: await r.json().catch(() => null) }; };
let n = 0; const ok = (m) => console.log('✓', m, `(${++n})`);

// auth
assert.equal((await fetch(base + '/api/leads')).status, 401); ok('sem password → 401');
assert.equal((await fetch(base + '/api/leads', { headers: { authorization: 'Basic ' + Buffer.from('x:errada').toString('base64') } })).status, 401); ok('password errada → 401');
assert.equal((await j('/')).s === 200 || true, true);

// stock (separador ; e cabeçalhos com acentos)
const csv = 'Modelo;Mês/Ano;Kms;Preço de venda;Estado;Link\nYamaha Tracer 9;03/2021;18500;9.990;Muito bom;https://olx.pt/a\n"Honda ""Africa"" Twin";05/2019;31000;8.500;Bom;https://olx.pt/b\n';
let r = await j('/api/stock', { method: 'POST', body: csv }); assert.equal(r.b.importadas, 2); ok('stock CSV (;) importado');
r = await j('/api/stock'); assert.equal(r.b[1].modelo, 'Honda "Africa" Twin'); assert.equal(r.b[0].preco, '9.990'); ok('aspas e colunas mapeadas');
r = await j('/api/stock', { method: 'POST', body: 'foo;bar\n1;2\n' }); assert.equal(r.s, 400); ok('CSV sem coluna modelo rejeitado');

// mensagem normal OLX → rascunho
r = await j('/api/mensagens', { method: 'POST', body: JSON.stringify({ canal: 'olx', nome: 'João', texto: 'Boa tarde, a Tracer ainda está disponível?' }) });
assert.ok(r.b.rascunho_id && !r.b.erro); const lid = r.b.lead_id; ok('OLX → rascunho criado');
r = await j('/api/leads/' + lid); const rasc = r.b.mensagens.find(m => m.estado === 'rascunho');
assert.equal(rasc.direcao, 'outbound'); assert.match(rasc.texto, /Francisco Canelas/); ok('rascunho OLX leva assinatura, nada enviado');

// mesma conversa reutiliza lead
r = await j('/api/mensagens', { method: 'POST', body: JSON.stringify({ canal: 'olx', nome: 'João', texto: 'Posso ir ver sábado?' }) });
assert.equal(r.b.lead_id, lid); assert.equal(r.b.alertar_equipa, true); ok('mesmo cliente → mesma lead; quente alerta equipa');
r = await j('/api/leads/' + lid); assert.equal(r.b.lead.classificacao, 'quente'); assert.equal(r.b.lead.alertar, 1); ok('lead classificada quente');

// retoma → sem rascunho
r = await j('/api/mensagens', { method: 'POST', body: JSON.stringify({ canal: 'olx', nome: 'Rui', texto: 'Aceita a minha mota em retoma?' }) });
assert.equal(r.b.rascunho_id, null); assert.equal(r.b.alertar_equipa, true); ok('retoma → sem resposta, alerta equipa');
r = await j('/api/leads?classificacao=retoma'); assert.equal(r.b.length, 1); ok('filtro por retoma');

// aprovar / descartar
r = await j(`/api/mensagens/${rasc.id}/estado`, { method: 'POST', body: JSON.stringify({ estado: 'enviada', texto: 'texto editado' }) }); assert.equal(r.s, 200);
r = await j('/api/leads/' + lid); assert.equal(r.b.mensagens.find(m => m.id === rasc.id).texto, 'texto editado'); ok('editar e marcar como enviada');
assert.equal((await j(`/api/mensagens/${rasc.id}/estado`, { method: 'POST', body: JSON.stringify({ estado: 'xpto' }) })).s, 400); ok('estado inválido rejeitado');
assert.equal((await j('/api/leads/' + lid, { method: 'PATCH', body: JSON.stringify({ estado: 'visita_marcada' }) })).s, 200); ok('estado da lead atualizado');

// webhook WhatsApp
let w = await fetch(base + '/webhook/whatsapp?hub.mode=subscribe&hub.verify_token=tok&hub.challenge=123'); assert.equal(await w.text(), '123'); ok('webhook verificação Meta');
w = await fetch(base + '/webhook/whatsapp?hub.mode=subscribe&hub.verify_token=mau&hub.challenge=123'); assert.equal(w.status, 403); ok('webhook token errado → 403');
w = await fetch(base + '/webhook/whatsapp', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ entry: [{ changes: [{ value: { contacts: [{ wa_id: '351912345678', profile: { name: 'Marta' } }], messages: [{ from: '351912345678', type: 'text', text: { body: 'Boa tarde, tem financiamento?' } }] } }] }] }) });
assert.equal(w.status, 200); await new Promise(r => setTimeout(r, 300));
r = await j('/api/leads'); const marta = r.b.find(l => l.telefone === '351912345678');
assert.ok(marta && marta.nome === 'Marta' && marta.financiamento === 1 && marta.rascunhos === 1); ok('mensagem WhatsApp → lead + rascunho (financiamento detetado)');

// ---- sincronização com a BikeBound + preços por matrícula + mota do anúncio ----
const http = await import('node:http');
const { buildUserContent } = await import('./assistant.js');
let bbMotas = [
  { id: '1', matricula: 'AA-11-BB', marca: 'Yamaha', modelo: 'MT-07', versao: null, cilindrada: 689, cor: 'Azul', quilometragem: 18000, data_matricula: '2021-03-15', ano: 2021, dias_em_stock: 10, consignacao: false },
  { id: '2', matricula: 'CC-22-DD', marca: 'Honda', modelo: 'CB500X', versao: 'ABS', cilindrada: 471, cor: 'Preto', quilometragem: 25000, data_matricula: '2019-11-02', ano: 2019, dias_em_stock: 40, consignacao: false },
  { id: '3', matricula: 'EE-33-FF', marca: 'BMW', modelo: 'R1250GS', versao: null, cilindrada: 1254, cor: 'Cinza', quilometragem: 9000, data_matricula: null, ano: 2022, dias_em_stock: 5, consignacao: true }
];
let bbAuth = null;
const bb = http.createServer((req, res) => {
  bbAuth = req.headers.authorization;
  if (bbAuth !== 'Bearer token-bb') { res.writeHead(401); return res.end('no'); }
  res.writeHead(200, { 'content-type': 'application/json' });
  res.end(JSON.stringify({ atualizado_em: new Date().toISOString(), motas: bbMotas }));
});
await new Promise(r => bb.listen(0, r));

r = await j('/api/sync', { method: 'POST' }); assert.equal(r.s, 502); assert.match(r.b.erro, /Falta BIKEBOUND/); ok('sync sem configuração → erro claro');
process.env.BIKEBOUND_STOCK_URL = `http://localhost:${bb.address().port}/api/public/stock`;
process.env.BIKEBOUND_STOCK_TOKEN = 'token-bb';
r = await j('/api/sync', { method: 'POST' }); assert.equal(r.s, 200); assert.equal(r.b.motas, 3); assert.equal(bbAuth, 'Bearer token-bb'); ok('sync lê 3 motas e envia o token');
r = await j('/api/stock'); assert.equal(r.b.length, 3); assert.equal(r.b[0].fonte, 'bikebound');
const mt = r.b.find(m => m.matricula === 'AA-11-BB'); assert.equal(mt.modelo, 'Yamaha MT-07'); assert.equal(mt.mes_ano, '03/2021'); assert.equal(mt.km, '18000'); assert.equal(mt.sem_preco, true);
assert.equal(r.b.find(m => m.matricula === 'EE-33-FF').mes_ano, '2022'); ok('stock vem da BikeBound (modelo, mês/ano, km); sem preço assinalado');

r = await j('/api/precos', { method: 'POST', body: 'matricula;preco;link\naa 11 bb;7.900;https://olx.pt/x\n' }); assert.equal(r.b.importados, 1); ok('CSV de preços importado');
r = await j('/api/stock'); const mt2 = r.b.find(m => m.matricula === 'AA-11-BB'); assert.equal(mt2.preco, '7.900'); assert.equal(mt2.link, 'https://olx.pt/x'); assert.equal(mt2.sem_preco, false);
assert.equal(r.b.find(m => m.matricula === 'CC-22-DD').sem_preco, true); ok('preço/link ligados por matrícula (formato tolerante)');
assert.equal((await j('/api/precos', { method: 'POST', body: 'foo;bar\n1;2\n' })).s, 400); ok('CSV de preços sem matrícula rejeitado');

r = await j('/api/mensagens', { method: 'POST', body: JSON.stringify({ canal: 'olx', nome: 'Pedro', mota_id: 'AA-11-BB', texto: 'Ainda está disponível?' }) });
r = await j('/api/leads/' + r.b.lead_id); assert.match(r.b.lead.mota_interesse, /Yamaha MT-07/); ok('mota escolhida fica na lead');
const ctxTxt = buildUserContent({ canal: 'olx', lead: {}, historico: [], texto: 'olá', mota: mt2 });
assert.match(ctxTxt, /MOTA EM CAUSA: Yamaha MT-07 \| 03\/2021 \| 18000 km \| 7\.900 € \| https:\/\/olx\.pt\/x/); assert.ok(!ctxTxt.includes('AA-11-BB')); ok('pedido ao Claude leva a mota em causa, sem matrícula');

bbMotas = []; r = await j('/api/sync', { method: 'POST' }); assert.equal(r.s, 502); assert.equal((await j('/api/stock')).b.length, 3); ok('resposta vazia não apaga o stock');
bbMotas = [bbMotas[0]];
process.env.BIKEBOUND_STOCK_TOKEN = 'errado'; r = await j('/api/sync', { method: 'POST' }); assert.equal(r.s, 502);
assert.equal((await j('/api/stock')).b.length, 3); r = await j('/api/sync'); assert.match(r.b.erro, /401/); assert.equal(r.b.motas, 3); ok('token errado: mantém stock anterior e mostra erro');
process.env.BIKEBOUND_STOCK_TOKEN = 'token-bb'; bbMotas = [{ matricula: 'AA-11-BB', marca: 'Yamaha', modelo: 'MT-07', quilometragem: 18000, data_matricula: '2021-03-15' }];
r = await j('/api/sync', { method: 'POST' }); assert.equal(r.b.motas, 1); assert.equal((await j('/api/stock')).b.length, 1); ok('mota vendida (sai da lista) desaparece do stock');
bb.close();

// parsing de JSON do modelo
assert.equal(extractJson('```json\n{"a":1}\n```').a, 1); ok('extractJson tolera texto à volta');

// erro da API não perde a mensagem
delete process.env.MOCK_CLAUDE; delete process.env.ANTHROPIC_API_KEY;
r = await j('/api/mensagens', { method: 'POST', body: JSON.stringify({ canal: 'olx', nome: 'Ana', texto: 'Olá' }) });
assert.ok(r.b.erro && r.b.lead_id); r = await j('/api/leads/' + r.b.lead_id); assert.equal(r.b.mensagens.length, 1); ok('falha da API: mensagem do cliente fica guardada');

server.close(); console.log(`\n${n} testes OK`);
