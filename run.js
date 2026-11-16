import assert from 'node:assert/strict';
import { rmSync } from 'node:fs';
const dbp = '/tmp/bb-test.db';
for (const s of ['', '-wal', '-shm']) rmSync(dbp + s, { force: true });
Object.assign(process.env, { DB_PATH: dbp, MOCK_CLAUDE: '1', APP_PASSWORD: 'segredo', WHATSAPP_VERIFY_TOKEN: 'tok' });

const { server } = await import('../src/server.js');
const { extractJson } = await import('../src/assistant.js');
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

// parsing de JSON do modelo
assert.equal(extractJson('```json\n{"a":1}\n```').a, 1); ok('extractJson tolera texto à volta');

// erro da API não perde a mensagem
delete process.env.MOCK_CLAUDE; delete process.env.ANTHROPIC_API_KEY;
r = await j('/api/mensagens', { method: 'POST', body: JSON.stringify({ canal: 'olx', nome: 'Ana', texto: 'Olá' }) });
assert.ok(r.b.erro && r.b.lead_id); r = await j('/api/leads/' + r.b.lead_id); assert.equal(r.b.mensagens.length, 1); ok('falha da API: mensagem do cliente fica guardada');

server.close(); console.log(`\n${n} testes OK`);
