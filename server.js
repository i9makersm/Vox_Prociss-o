import 'dotenv/config';
import crypto from 'node:crypto';
import express from 'express';
import http from 'node:http';
import { Server } from 'socket.io';
import { createAdapter } from '@socket.io/redis-adapter';
import { createClient } from 'redis';
import { AccessToken, TrackSource } from 'livekit-server-sdk';
import { createStorage } from './lib/storage.js';

const app = express();
const server = http.createServer(app);
const io = new Server(server);

const port = Number(process.env.PORT || 3000);
const livekitUrl = process.env.LIVEKIT_URL || '';
const livekitApiKey = process.env.LIVEKIT_API_KEY || '';
const livekitApiSecret = process.env.LIVEKIT_API_SECRET || '';
const publicAppUrl = process.env.PUBLIC_APP_URL || '';
const dataDir = process.env.DATA_DIR || `${process.cwd()}/data`;
const databaseUrl = process.env.DATABASE_URL || '';
const redisUrl = process.env.REDIS_URL || '';
const storage = createStorage({ dataDir, databaseUrl });

const events = new Map();
const presence = new Map();
const instanceId = crypto.randomBytes(6).toString('hex');
let redisPresenceClient = null;

app.set('trust proxy', 1);
app.use(express.json());
app.use('/assets', express.static(`${process.cwd()}/assets`));
app.use('/vendor/livekit', express.static(`${process.cwd()}/node_modules/livekit-client/dist`));

function token(size = 18) {
  return crypto.randomBytes(size).toString('base64url');
}

async function loadEvents() {
  await storage.init();
  const storedEvents = await storage.loadEvents();
  for (const event of storedEvents) {
    events.set(event.id, event);
    ensurePresence(event.id);
  }
}

async function saveEvent(event) {
  await storage.saveEvent(event);
}

async function setupRedisAdapter() {
  if (!redisUrl) return;

  const pubClient = createClient({ url: redisUrl });
  const subClient = pubClient.duplicate();
  redisPresenceClient = pubClient.duplicate();
  await Promise.all([pubClient.connect(), subClient.connect(), redisPresenceClient.connect()]);
  io.adapter(createAdapter(pubClient, subClient));
  console.log('Socket.IO Redis adapter ativo.');
}

function publicUrlFromRequest(req) {
  if (publicAppUrl) return publicAppUrl;
  const protocol = req.get('x-forwarded-proto') || req.protocol;
  const host = req.get('x-forwarded-host') || req.get('host');
  return host ? `${protocol}://${host}` : '';
}

function publicEvent(event) {
  return {
    id: event.id,
    name: event.name,
    type: event.type,
    organizerName: event.organizerName,
    city: event.city,
    state: event.state,
    eventDate: event.eventDate,
    eventTime: event.eventTime,
    startLocation: event.startLocation,
    destination: event.destination,
    coordinatorName: event.coordinatorName,
    coordinatorPhone: event.coordinatorPhone,
    notes: event.notes,
    roomName: event.roomName,
    live: event.live,
    createdAt: event.createdAt
  };
}

function eventInput(body) {
  return {
    name: String(body.name || '').trim(),
    type: String(body.type || 'procissao').trim(),
    organizerName: String(body.organizerName || '').trim(),
    city: String(body.city || '').trim(),
    state: String(body.state || '').trim().toUpperCase(),
    eventDate: String(body.eventDate || '').trim(),
    eventTime: String(body.eventTime || '').trim(),
    startLocation: String(body.startLocation || '').trim(),
    destination: String(body.destination || '').trim(),
    coordinatorName: String(body.coordinatorName || '').trim(),
    coordinatorPhone: String(body.coordinatorPhone || '').trim(),
    notes: String(body.notes || '').trim()
  };
}

function validateEventInput(input) {
  if (!input.name || !input.organizerName || !input.city || !input.eventDate || !input.eventTime || !input.startLocation || !input.destination || !input.coordinatorName) {
    return 'Informe nome do evento, paroquia/grupo, cidade, data, horario, saida, destino e coordenador.';
  }
  return '';
}

function coordinatorEvent(event) {
  return {
    ...publicEvent(event),
    links: event.links,
    transmitters: event.transmitters
  };
}

function eventByLink(kind, linkToken) {
  for (const event of events.values()) {
    if (event.links[kind] === linkToken) return event;
  }
  return null;
}

function ensurePresence(eventId) {
  if (!presence.has(eventId)) {
    presence.set(eventId, {
      listeners: new Set(),
      coordinators: new Set(),
      transmitters: new Set()
    });
  }
  return presence.get(eventId);
}

async function roleCount(eventId, role) {
  if (redisPresenceClient) {
    return redisPresenceClient.sCard(`presence:${eventId}:${role}`);
  }
  const p = ensurePresence(eventId);
  return p[role].size;
}

async function statusFor(eventId) {
  const event = events.get(eventId);
  return {
    eventId,
    listeners: await roleCount(eventId, 'listeners'),
    coordinators: await roleCount(eventId, 'coordinators'),
    transmittersOnline: await roleCount(eventId, 'transmitters'),
    live: Boolean(event?.live),
    transmitters: event?.transmitters || []
  };
}

async function emitStatus(eventId) {
  io.to(`event:${eventId}`).emit('event:status', await statusFor(eventId));
}

function roleSetName(role) {
  if (role === 'listener') return 'listeners';
  if (role === 'coordinator') return 'coordinators';
  if (role === 'transmitter') return 'transmitters';
  return null;
}

async function addPresence(eventId, role, socketId) {
  const roleSet = roleSetName(role);
  if (!roleSet) return;
  const member = `${instanceId}:${socketId}`;

  if (redisPresenceClient) {
    await redisPresenceClient.sAdd(`presence:${eventId}:${roleSet}`, member);
    return;
  }

  ensurePresence(eventId)[roleSet].add(member);
}

async function removePresence(eventId, role, socketId) {
  const roleSet = roleSetName(role);
  if (!roleSet) return;
  const member = `${instanceId}:${socketId}`;

  if (redisPresenceClient) {
    await redisPresenceClient.sRem(`presence:${eventId}:${roleSet}`, member);
    return;
  }

  ensurePresence(eventId)[roleSet].delete(member);
}

function requireLiveKit() {
  if (!livekitUrl || !livekitApiKey || !livekitApiSecret) {
    const err = new Error('LiveKit nao configurado. Defina LIVEKIT_URL, LIVEKIT_API_KEY e LIVEKIT_API_SECRET.');
    err.statusCode = 503;
    throw err;
  }
}

async function makeLiveKitToken({ event, identity, name, canPublish }) {
  requireLiveKit();

  const accessToken = new AccessToken(livekitApiKey, livekitApiSecret, {
    identity,
    name,
    ttl: '6h',
    metadata: JSON.stringify({ eventId: event.id, eventName: event.name })
  });

  accessToken.addGrant({
    room: event.roomName,
    roomJoin: true,
    canSubscribe: true,
    canPublish,
    canPublishData: true,
    canPublishSources: canPublish ? [TrackSource.MICROPHONE] : []
  });

  return Promise.resolve(accessToken.toJwt());
}

app.get('/api/config', (req, res) => {
  res.json({
    livekitUrl,
    publicAppUrl: publicUrlFromRequest(req),
    livekitReady: Boolean(livekitUrl && livekitApiKey && livekitApiSecret)
  });
});

app.get('/api/health', (req, res) => {
  res.json({
    ok: true,
    livekitReady: Boolean(livekitUrl && livekitApiKey && livekitApiSecret),
    publicAppUrl: publicUrlFromRequest(req),
    storage: storage.description,
    redisReady: Boolean(redisUrl)
  });
});

app.post('/api/events', async (req, res, next) => {
  try {
  const input = eventInput(req.body);
  const error = validateEventInput(input);
  if (error) return res.status(400).json({ error });

  const id = token(10);
  const event = {
    id,
    ...input,
    roomName: `vox-${id}`,
    live: true,
    createdAt: new Date().toISOString(),
    links: {
      coordinator: token(),
      transmitter: token(),
      listener: token()
    },
    transmitters: []
  };

  events.set(id, event);
  ensurePresence(id);
  await saveEvent(event);
  res.status(201).json(coordinatorEvent(event));
  } catch (error) {
    next(error);
  }
});

app.put('/api/events/:eventId', async (req, res, next) => {
  try {
    const event = events.get(req.params.eventId);
    if (!event || req.body.adminToken !== event.links.coordinator) {
      return res.status(403).json({ error: 'Acesso do coordenador invalido.' });
    }

    const input = eventInput(req.body);
    const error = validateEventInput(input);
    if (error) return res.status(400).json({ error });

    Object.assign(event, input, { updatedAt: new Date().toISOString() });
    await saveEvent(event);

    io.to(`event:${event.id}`).emit('event:updated', publicEvent(event));
    await emitStatus(event.id);
    res.json(coordinatorEvent(event));
  } catch (error) {
    next(error);
  }
});

app.get('/api/link/:kind/:linkToken', (req, res) => {
  const { kind, linkToken } = req.params;
  if (!['coordinator', 'transmitter', 'listener'].includes(kind)) {
    return res.status(404).json({ error: 'Link invalido.' });
  }

  const event = eventByLink(kind, linkToken);
  if (!event) return res.status(404).json({ error: 'Evento nao encontrado.' });

  res.json(kind === 'coordinator' ? coordinatorEvent(event) : publicEvent(event));
});

app.post('/api/events/:eventId/transmitters/request', async (req, res, next) => {
  try {
  const event = events.get(req.params.eventId);
  if (!event || req.body.linkToken !== event.links.transmitter) {
    return res.status(403).json({ error: 'Link de transmissor invalido.' });
  }

  const name = String(req.body.name || '').trim();
  const role = String(req.body.role || '').trim();
  if (!name || !role) {
    return res.status(400).json({ error: 'Informe nome e funcao.' });
  }

  const existing = event.transmitters.find(
    item => item.name.toLowerCase() === name.toLowerCase() && item.role.toLowerCase() === role.toLowerCase()
  );

  const request = existing || {
    id: token(8),
    name,
    role,
    status: 'pending',
    requestedAt: new Date().toISOString()
  };

  if (!existing) event.transmitters.push(request);
  await saveEvent(event);

  io.to(`event:${event.id}`).emit('transmitter:requested', request);
  await emitStatus(event.id);
  res.status(existing ? 200 : 201).json(request);
  } catch (error) {
    next(error);
  }
});

app.post('/api/events/:eventId/transmitters/:requestId/:decision', async (req, res, next) => {
  try {
  const event = events.get(req.params.eventId);
  if (!event || req.body.adminToken !== event.links.coordinator) {
    return res.status(403).json({ error: 'Acesso do coordenador invalido.' });
  }

  const transmitter = event.transmitters.find(item => item.id === req.params.requestId);
  if (!transmitter) return res.status(404).json({ error: 'Solicitacao nao encontrada.' });

  if (req.params.decision === 'approve') {
    transmitter.status = 'approved';
    transmitter.approvedAt = new Date().toISOString();
    io.to(`request:${transmitter.id}`).emit('transmitter:approved', transmitter);
  } else if (req.params.decision === 'reject') {
    transmitter.status = 'rejected';
    transmitter.rejectedAt = new Date().toISOString();
    io.to(`request:${transmitter.id}`).emit('transmitter:rejected', transmitter);
  } else {
    return res.status(404).json({ error: 'Decisao invalida.' });
  }

  io.to(`event:${event.id}`).emit('transmitter:updated', transmitter);
  await saveEvent(event);
  await emitStatus(event.id);
  res.json(transmitter);
  } catch (error) {
    next(error);
  }
});

app.post('/api/events/:eventId/livekit-token', async (req, res, next) => {
  try {
    const event = events.get(req.params.eventId);
    if (!event) return res.status(404).json({ error: 'Evento nao encontrado.' });

    const mode = String(req.body.mode || '');
    let identity = '';
    let name = '';
    let canPublish = false;

    if (mode === 'listener') {
      if (req.body.linkToken !== event.links.listener) {
        return res.status(403).json({ error: 'Link de ouvinte invalido.' });
      }
      identity = `ouvinte-${token(6)}`;
      name = 'Ouvinte';
    } else if (mode === 'coordinator') {
      if (req.body.linkToken !== event.links.coordinator) {
        return res.status(403).json({ error: 'Acesso do coordenador invalido.' });
      }
      identity = `coordenador-${token(6)}`;
      name = event.coordinatorName;
    } else if (mode === 'transmitter') {
      if (req.body.linkToken !== event.links.transmitter) {
        return res.status(403).json({ error: 'Link de transmissor invalido.' });
      }
      const transmitter = event.transmitters.find(item => item.id === req.body.transmitterId);
      if (!transmitter || transmitter.status !== 'approved') {
        return res.status(403).json({ error: 'Transmissor ainda nao autorizado.' });
      }
      identity = `transmissor-${transmitter.id}`;
      name = `${transmitter.name} - ${transmitter.role}`;
      canPublish = true;
    } else {
      return res.status(400).json({ error: 'Modo invalido.' });
    }

    const participantToken = await makeLiveKitToken({ event, identity, name, canPublish });
    res.json({ livekitUrl, token: participantToken, roomName: event.roomName });
  } catch (error) {
    next(error);
  }
});

app.post('/api/events/:eventId/end', async (req, res, next) => {
  try {
  const event = events.get(req.params.eventId);
  if (!event || req.body.adminToken !== event.links.coordinator) {
    return res.status(403).json({ error: 'Acesso do coordenador invalido.' });
  }

  event.live = false;
  await saveEvent(event);
  io.to(`event:${event.id}`).emit('event:ended');
  await emitStatus(event.id);
  res.json({ live: false });
  } catch (error) {
    next(error);
  }
});

io.on('connection', socket => {
  socket.on('event:join', async ({ eventId, role, requestId }) => {
    const event = events.get(eventId);
    if (!event) return;

    socket.join(`event:${eventId}`);
    if (requestId) socket.join(`request:${requestId}`);

    socket.data.eventId = eventId;
    socket.data.role = role;
    await addPresence(eventId, role, socket.id);
    await emitStatus(eventId);
  });

  socket.on('disconnect', async () => {
    const { eventId, role } = socket.data;
    if (!eventId || !role) return;

    await removePresence(eventId, role, socket.id);
    await emitStatus(eventId);
  });
});

app.use((error, _req, res, _next) => {
  const status = error.statusCode || 500;
  res.status(status).json({ error: error.message || 'Erro interno.' });
});

app.get(/^\/(?!api|socket\.io).*/, (_req, res) => {
  res.sendFile(`${process.cwd()}/index.html`);
});

async function main() {
  await loadEvents();
  await setupRedisAdapter();

  server.listen(port, '0.0.0.0', () => {
    console.log(`Vox Procissao em http://localhost:${port}`);
    console.log(livekitUrl ? `LiveKit configurado em ${livekitUrl}` : 'LiveKit ainda nao configurado.');
    console.log(`Armazenamento: ${storage.description}`);
    if (publicAppUrl) console.log(`Links publicos em ${publicAppUrl}`);
    if (publicAppUrl.startsWith('http://') && !publicAppUrl.includes('localhost')) {
      console.warn('AVISO: para uso publico real, PUBLIC_APP_URL deve usar https://');
    }
    if (livekitUrl.startsWith('ws://') && !livekitUrl.includes('localhost')) {
      console.warn('AVISO: para uso publico real, LIVEKIT_URL deve usar wss://');
    }
  });
}

main().catch(error => {
  console.error(error);
  process.exit(1);
});
