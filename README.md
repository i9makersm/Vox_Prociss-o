# Vox Procissao

Radio ao vivo para procissoes e caminhadas com:

- coordenador como gerenciador do evento;
- nome da procissao/caminhada, local de saida e destino;
- link privado do coordenador;
- link para transmissores se identificarem e aguardarem autorizacao;
- link publico de ouvintes, sem login;
- contador de ouvintes em tempo real;
- audio ao vivo via LiveKit.

## Requisitos

- Node.js 20 ou superior
- Um servidor LiveKit:
  - LiveKit Cloud, usando o plano gratuito inicial, recomendado para producao; ou
  - LiveKit self-hosted, usando o `livekit.yaml` deste projeto.

## Configuracao

Crie o arquivo `.env` a partir do exemplo:

```bash
cp .env.example .env
```

Para LiveKit Cloud, preencha:

```env
PUBLIC_APP_URL=https://vox-procissao.seudominio.com
LIVEKIT_URL=wss://seu-projeto.livekit.cloud
LIVEKIT_API_KEY=sua_api_key
LIVEKIT_API_SECRET=seu_api_secret
```

Para LiveKit local, use:

```env
LIVEKIT_URL=ws://localhost:7880
LIVEKIT_API_KEY=devkey
LIVEKIT_API_SECRET=secret
```

## Rodando o LiveKit local

O projeto ja inclui o binario do LiveKit Server em `./bin/livekit-server`.

Inicie o servidor de midia:

```bash
npm run livekit
```

Esse modo usa:

```text
LIVEKIT_URL=ws://localhost:7880
LIVEKIT_API_KEY=devkey
LIVEKIT_API_SECRET=secret
```

Para liberar o LiveKit em outros dispositivos da rede:

```bash
npm run livekit:lan
```

Em celular ou fora de `localhost`, navegadores costumam exigir HTTPS para liberar microfone. Para producao, use dominio com TLS ou LiveKit Cloud.

## Rodando o LiveKit local com Docker

Com Docker:

```bash
docker run --rm \
  -p 7880:7880 \
  -p 7881:7881 \
  -p 50000-50100:50000-50100/udp \
  -v "$PWD/livekit.yaml:/livekit.yaml" \
  livekit/livekit-server \
  --config /livekit.yaml
```

## Rodando o Vox Procissao

Instale dependencias:

```bash
npm install
```

Inicie:

```bash
npm run dev
```

Acesse:

```text
http://localhost:3000
```

Para enviar links para outro celular ou computador na mesma rede, use o endereco configurado em `PUBLIC_APP_URL`, por exemplo:

```text
http://192.168.100.209:3000
```

Links com `localhost` funcionam somente no proprio computador onde o servidor esta rodando.

## Producao real para qualquer cidade

Para enviar links para qualquer pessoa pela internet, o app precisa estar em uma hospedagem publica com HTTPS e o LiveKit precisa estar em uma URL publica WSS.

Configuracao recomendada:

- Hospedar o app em Render, Railway, Fly.io, VPS, DigitalOcean, Hetzner ou outro servidor publico.
- Usar LiveKit Cloud para o audio, porque ele ja entrega `wss://`, TURN e infraestrutura publica.
- Usar Postgres para eventos e solicitações.
- Usar Redis se o app rodar com mais de uma instância.
- Configurar `PUBLIC_APP_URL` com a URL HTTPS do app.
- Configurar `LIVEKIT_URL`, `LIVEKIT_API_KEY` e `LIVEKIT_API_SECRET` com os dados do projeto LiveKit Cloud.

Exemplo de `.env` de producao:

```env
PUBLIC_APP_URL=https://vox-procissao.seudominio.com
LIVEKIT_URL=wss://seu-projeto.livekit.cloud
LIVEKIT_API_KEY=sua_api_key
LIVEKIT_API_SECRET=sua_api_secret
DATABASE_URL=postgres://usuario:senha@host:5432/vox_procissao
REDIS_URL=redis://usuario:senha@host:6379
DATA_DIR=/app/data
PORT=3000
```

O arquivo [.env.production.example](./.env.production.example) ja esta pronto para esse cenario.

### Deploy no Render

O projeto inclui [render.yaml](./render.yaml). Ele cria:

- um Web Service Free para o app;
- um Postgres Free para persistir os eventos de teste.

No Render:

1. Crie um novo Web Service apontando para este projeto.
2. Use o Blueprint/`render.yaml` ou configure manualmente:
   - Build Command: `npm ci`
   - Start Command: `npm run start`
   - Health Check Path: `/api/health`
3. Configure as variaveis obrigatorias:
   - `LIVEKIT_URL`
   - `LIVEKIT_API_KEY`
   - `LIVEKIT_API_SECRET`
4. `DATABASE_URL` e criada automaticamente pelo Postgres do Blueprint.
5. Depois do deploy, abra a URL HTTPS gerada pelo Render.

`PUBLIC_APP_URL` e opcional. Se nao preencher, o app usa automaticamente o dominio publico da requisicao, como `https://vox-procissao.onrender.com`.

### Deploy com Docker

Build:

```bash
docker build -t vox-procissao .
```

Run:

```bash
docker run -p 3000:3000 \
  -e PUBLIC_APP_URL=https://vox-procissao.seudominio.com \
  -e LIVEKIT_URL=wss://seu-projeto.livekit.cloud \
  -e LIVEKIT_API_KEY=sua_api_key \
  -e LIVEKIT_API_SECRET=sua_api_secret \
  -e DATABASE_URL=postgres://usuario:senha@host:5432/vox_procissao \
  -e REDIS_URL=redis://usuario:senha@host:6379 \
  -e DATA_DIR=/app/data \
  -v vox-procissao-data:/app/data \
  vox-procissao
```

## Grandes multidões

Para centenas ou milhares de ouvintes, a arquitetura recomendada e:

- LiveKit Cloud para áudio WebRTC.
- App Node hospedado em Render/Railway/Fly.io/VPS com HTTPS.
- Postgres para persistir eventos, links e autorizações.
- Redis para sincronizar presença e eventos do Socket.IO se houver mais de uma instância do app.
- Plano LiveKit dimensionado para a quantidade esperada de ouvintes/minutos.

O app ja esta preparado para isso:

- Se `DATABASE_URL` existir, usa Postgres.
- Se `REDIS_URL` existir, usa Redis Adapter no Socket.IO.
- Se essas variáveis não existirem, cai para arquivo local, útil apenas para teste.

Para o primeiro teste publico, voce pode ficar sem Redis. Use Redis apenas quando escalar o app para mais de uma instancia.

### LiveKit self-hosted em producao

Tambem e possivel, mas exige VPS, dominio, HTTPS, TURN e firewall. Segundo a documentacao oficial do LiveKit, as portas publicas necessarias incluem `443`, `80`, `7881`, `3478/UDP` e `50000-60000/UDP`. Para este projeto, LiveKit Cloud e o caminho mais simples e confiavel.

## Fluxo de uso

1. O coordenador cria o evento.
2. O sistema gera tres links: coordenador, transmissores e ouvintes.
3. O transmissor abre o link, informa nome e funcao.
4. O coordenador aprova ou recusa.
5. Apos aprovado, o transmissor conecta e liga o microfone.
6. O ouvinte abre o link publico e entra sem login. Ele ja conta no painel; para ouvir, toca no botao de audio.

## Observacao importante

Os eventos agora sao salvos em arquivo JSON dentro de `DATA_DIR`. Em producao, configure essa pasta em um disco persistente. Em uma evolucao maior, o ideal e trocar por PostgreSQL ou Supabase.
