# BikeBound Leads

Assistente de leads do stand: recebe mensagens (OLX e WhatsApp), prepara um rascunho de resposta com o Claude, classifica o lead e mostra tudo numa página com login. **Nada é enviado sozinho**: tu aprovas cada resposta.

## O que faz
- Página de leads (quente / morna / fria / retoma), ficha com conversa e rascunho editável.
- Retomas: marca como retoma, não gera resposta e avisa a equipa.
- Stock sincronizado automaticamente (de hora a hora) com a BikeBound: só motas disponíveis. Se falhar, mantém o stock anterior.
- Preço e link do OLX por matrícula, por CSV (matricula, preco, link). As motas sem preço aparecem assinaladas.
- Stock manual por CSV (modelo, mes_ano, km, preco, estado, link) só como alternativa, se a sincronização não estiver ativa.
- Na "Nova mensagem" podes escolher a mota do anúncio, e o assistente responde sobre ela.
- WhatsApp: endpoint `/webhook/whatsapp` pronto para a API oficial da Meta.
- OLX: cola a mensagem em "Nova mensagem" (ligação automática ainda por fazer).

## Variáveis (Railway → Variables)
| Variável | Valor |
|---|---|
| `APP_PASSWORD` | palavra-passe de acesso à página (utilizador: qualquer) |
| `ANTHROPIC_API_KEY` | chave da API do Claude (console.anthropic.com) |
| `DB_PATH` | `/data/leads.db` |
| `WHATSAPP_VERIFY_TOKEN` | texto secreto à tua escolha (usado na configuração da Meta) |
| `CLAUDE_MODEL` | opcional; por defeito `claude-haiku-5-5` |
| `BIKEBOUND_STOCK_URL` | endereço público da BikeBound + `/api/public/stock` |
| `BIKEBOUND_STOCK_TOKEN` | o mesmo valor do segredo `STOCK_API_TOKEN` criado no Lovable |

## Deploy no Railway
1. Colocar esta pasta num repositório GitHub (privado) e, no Railway, "New Project → Deploy from GitHub".
2. Em Settings → Volumes, criar um volume montado em `/data`.
3. Adicionar as variáveis acima. Comando de arranque: `npm start`.
4. Em Settings → Networking, gerar o domínio público.
5. Abrir o link, entrar com a palavra-passe, separador Stock → carregar o CSV.

## Ligar o WhatsApp (depois)
Na Meta for Developers: criar app → produto WhatsApp → número do stand. Em Webhooks, URL `https://<teu-dominio>/webhook/whatsapp`, token = `WHATSAPP_VERIFY_TOKEN`, subscrever o campo `messages`.

## Testes
`npm test` (usa um Claude simulado e uma BikeBound simulada, não gasta nada).

## Ainda não incluído
- Envio automático (fica para depois, quando decidires).
- Aviso à equipa por WhatsApp (hoje aparece a etiqueta "avisar equipa" na página).
- Ligação automática ao OLX.
- Preço e link dentro da BikeBound (hoje ficam neste serviço).
