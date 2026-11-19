# BikeBound Leads

Assistente de leads do stand: recebe mensagens (OLX e WhatsApp), prepara um rascunho de resposta com o Claude, classifica o lead e mostra tudo numa página com palavra-passe. **Nada é enviado sozinho**: a equipa aprova cada resposta.

## O que faz
- Página de leads (quente / morna / fria / retoma), ficha com a conversa e rascunho editável.
- Stock sincronizado de hora a hora com a BikeBound (só motas disponíveis). Preço e link do OLX por matrícula, por CSV.
- Na "Nova mensagem" escolhe-se o cliente (novo ou existente) e a mota do anúncio.
- Separador "Instruções": texto que o assistente segue (horário, morada, garantia…), telefone do stand e assinatura do OLX.
- O assistente usa as últimas respostas aprovadas pela equipa como referência de tom.
- Cada rascunho é verificado: preços e links que não constem do stock ficam com aviso.
- Retomas: pede os dados da mota do cliente, nunca dá valor, e avisa a equipa.
- Cópia de segurança de leads e conversas (separador "Instruções").
- Importação de conversas já existentes (separador "Instruções" ou `POST /api/importar`): só regista o histórico, sem rascunhos, e pode repetir-se sem duplicar.
- Filtro de leads por mota, com o número de interessados em cada uma.
- Mesmo cliente no OLX e no WhatsApp: o telefone escrito no chat do OLX fica guardado, e as mensagens desse número no WhatsApp entram na mesma lead. Quando não há telefone, a ficha sugere leads parecidas e permite juntá-las.
- OLX: ligação pela API de parceiros (Instruções → Ligar ao OLX). De 5 em 5 minutos lê as conversas das motas em stock, cria rascunhos para mensagens novas e não duplica o que já foi importado. Não envia nada.
- WhatsApp: endpoint `/webhook/whatsapp` pronto para a API oficial da Meta (só aceita mensagens assinadas).

## Variáveis (Railway → Variables)
| Variável | Valor |
|---|---|
| `APP_PASSWORD` | palavra-passe da página (12+ caracteres; utilizador: qualquer) |
| `ANTHROPIC_API_KEY` | chave da API do Claude |
| `DB_PATH` | `/data/leads.db` (com um volume montado em `/data`) |
| `BIKEBOUND_STOCK_URL` | endereço público da BikeBound + `/api/public/stock` |
| `BIKEBOUND_STOCK_TOKEN` | o mesmo valor do segredo `STOCK_API_TOKEN` criado no Lovable |
| `WHATSAPP_VERIFY_TOKEN` | texto secreto usado na configuração do webhook na Meta |
| `WHATSAPP_APP_SECRET` | "App Secret" da app na Meta. Sem ele, o webhook recusa todas as mensagens |
| `CLAUDE_MODEL` | opcional; por defeito `claude-haiku-5-5` |
| `OLX_CLIENT_ID` | Client ID da aplicação aprovada em developer.olx.pt |
| `OLX_CLIENT_SECRET` | Client Secret dessa aplicação |
| `STAND_TELEFONE` | opcional; por defeito `927887107` (também se muda na página) |

## Segurança
- Palavra-passe comparada em tempo constante; 10 tentativas erradas bloqueiam o endereço durante 15 minutos.
- Pedidos que alteram dados só são aceites vindos da própria página.
- O texto do cliente é tratado como dados, nunca como instruções para o assistente.
- A página guarda dados pessoais de clientes (nome, telefone, conversas): usar palavra-passe forte, apagar leads que já não interessam e guardar as cópias de segurança em local seguro.

## Testes
`npm test` (usa um Claude, uma BikeBound e um WhatsApp simulados; não gasta nada).

## Ainda não incluído
- Envio automático de respostas e aviso à equipa por WhatsApp.
- Preço e link dentro da BikeBound (hoje ficam neste serviço).
