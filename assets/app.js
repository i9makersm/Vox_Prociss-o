import {
  Room,
  RoomEvent,
  Track
} from '/vendor/livekit/livekit-client.esm.mjs';

const app = document.querySelector('#app');
const audioOutput = document.querySelector('#audio-output');
const toastRoot = document.querySelector('#toast-root');
const socket = window.io();
const remoteAudio = document.createElement('audio');
remoteAudio.id = 'remote-audio';
remoteAudio.autoplay = true;
remoteAudio.playsInline = true;
remoteAudio.controls = false;
audioOutput.appendChild(remoteAudio);

let appConfig = {
  publicAppUrl: ''
};
let wakeLock = null;

let current = {
  role: null,
  linkToken: null,
  event: null,
  request: null,
  room: null,
  micOn: false,
  status: {
    listeners: 0,
    coordinators: 0,
    transmittersOnline: 0,
    transmitters: []
  }
};

const pathParts = window.location.pathname.split('/').filter(Boolean);

function escapeHtml(value) {
  return String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#039;');
}

function selected(value, expected) {
  return value === expected ? 'selected' : '';
}

function toast(message) {
  const el = document.createElement('div');
  el.className = 'toast';
  el.textContent = message;
  toastRoot.appendChild(el);
  setTimeout(() => el.remove(), 3600);
}

async function requestWakeLock() {
  if (!('wakeLock' in navigator)) return false;
  try {
    wakeLock = await navigator.wakeLock.request('screen');
    wakeLock.addEventListener('release', () => {
      wakeLock = null;
    });
    return true;
  } catch (_error) {
    return false;
  }
}

async function releaseWakeLock() {
  if (!wakeLock) return;
  await wakeLock.release().catch(() => {});
  wakeLock = null;
}

function setupMediaSession(event, mode) {
  if (!('mediaSession' in navigator)) return;
  navigator.mediaSession.metadata = new MediaMetadata({
    title: event.name,
    artist: mode === 'transmitter' ? 'Vox Procissao - Transmissor' : 'Vox Procissao - Ao Vivo',
    album: `${event.startLocation} ate ${event.destination}`
  });
  navigator.mediaSession.playbackState = 'playing';
  ['play', 'pause', 'stop'].forEach(action => {
    try {
      navigator.mediaSession.setActionHandler(action, async () => {
        if (action === 'play') await remoteAudio.play().catch(() => {});
        if (action === 'pause') remoteAudio.pause();
        if (action === 'stop' && current.room) await current.room.disconnect();
      });
    } catch (_error) {}
  });
}

document.addEventListener('visibilitychange', async () => {
  if (document.visibilityState === 'visible' && current.room && current.role === 'listener') {
    await requestWakeLock();
    await remoteAudio.play().catch(() => {});
  }
});

async function api(path, options = {}) {
  const response = await fetch(path, {
    headers: { 'Content-Type': 'application/json', ...(options.headers || {}) },
    ...options
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(body.error || 'Erro na requisicao.');
  return body;
}

function absolutePath(path) {
  const baseUrl = appConfig.publicAppUrl || window.location.origin;
  return `${baseUrl.replace(/\/$/, '')}${path}`;
}

function linkFor(kind, token) {
  const prefix = { coordinator: 'c', transmitter: 't', listener: 'o' }[kind];
  return absolutePath(`/${prefix}/${token}`);
}

function renderShell(content, actions = '') {
  app.innerHTML = `
    <header class="topbar">
      <div class="brand">
        <div class="brand-mark">✝</div>
        <div>
          <h1 class="brand-title">Vox Procissao</h1>
          <div class="brand-subtitle">Radio ao vivo para caminhadas</div>
        </div>
      </div>
      <div class="actions">${actions}</div>
    </header>
    ${content}
  `;
}

function renderHome() {
  const livekitNotice = appConfig.livekitReady ? '' : `
    <div class="notice">
      LiveKit ainda nao esta configurado. A criacao de eventos funciona, mas o audio real precisa de LIVEKIT_URL, LIVEKIT_API_KEY e LIVEKIT_API_SECRET.
    </div>
  `;

  renderShell(`
    <section class="grid">
      <div class="hero">
        <span class="pill live">Nova transmissao</span>
        <h2>Defina o nome da procissao ou caminhada</h2>
        <p class="lead">
          O coordenador cria o evento, envia links separados e aprova cada pessoa
          que podera transmitir. O link dos ouvintes entra direto e conta no painel.
        </p>
      </div>

      <form id="create-form" class="card form">
        <h2>Criar evento</h2>
        ${livekitNotice}
        <div class="field">
          <label for="coordinatorName">Nome do coordenador</label>
          <input id="coordinatorName" name="coordinatorName" autocomplete="name" required placeholder="Ex: Coordenador da procissao">
        </div>
        <div class="field">
          <label for="coordinatorPhone">Telefone do coordenador</label>
          <input id="coordinatorPhone" name="coordinatorPhone" inputmode="tel" autocomplete="tel" placeholder="Ex: telefone de contato">
        </div>
        <div class="field">
          <label for="name">Defina o nome</label>
          <input id="name" name="name" required placeholder="Ex: Procissao de Nossa Senhora Aparecida">
        </div>
        <div class="field">
          <label for="organizerName">Paroquia / grupo responsavel</label>
          <input id="organizerName" name="organizerName" required placeholder="Ex: Paroquia Sao Joao Evangelista">
        </div>
        <div class="field">
          <label for="type">Tipo</label>
          <select id="type" name="type">
            <option value="procissao">Procissao</option>
            <option value="caminhada">Caminhada</option>
            <option value="outro">Outro</option>
          </select>
        </div>
        <div class="field">
          <label for="city">Cidade</label>
          <input id="city" name="city" required placeholder="Ex: Sao Paulo">
        </div>
        <div class="field">
          <label for="state">Estado</label>
          <input id="state" name="state" maxlength="2" placeholder="Ex: SP">
        </div>
        <div class="field">
          <label for="eventDate">Data</label>
          <input id="eventDate" name="eventDate" type="date" required>
        </div>
        <div class="field">
          <label for="eventTime">Horario de inicio</label>
          <input id="eventTime" name="eventTime" type="time" required>
        </div>
        <div class="field">
          <label for="startLocation">Local de saida</label>
          <input id="startLocation" name="startLocation" required placeholder="Ex: Igreja Matriz">
        </div>
        <div class="field">
          <label for="destination">Destino</label>
          <input id="destination" name="destination" required placeholder="Ex: Santuario Sao Jose">
        </div>
        <div class="field">
          <label for="notes">Observacoes para equipe</label>
          <textarea id="notes" name="notes" rows="3" placeholder="Ex: chegada prevista, trio eletrico, equipe de canto, pontos de parada"></textarea>
        </div>
        <button class="btn" type="submit">Criar procissao</button>
        <p class="muted">
          Depois de criar, guarde o link do coordenador. Ele e a chave de gerenciamento do evento.
        </p>
      </form>
    </section>
  `);

  document.querySelector('#create-form').addEventListener('submit', async event => {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    try {
      const created = await api('/api/events', {
        method: 'POST',
        body: JSON.stringify(Object.fromEntries(form.entries()))
      });
      window.history.replaceState(null, '', `/c/${created.links.coordinator}`);
      await loadByLink('coordinator', created.links.coordinator);
      toast('Evento criado. Voce e o coordenador.');
    } catch (error) {
      toast(error.message);
    }
  });
}

async function loadByLink(kind, linkToken) {
  const event = await api(`/api/link/${kind}/${linkToken}`);
  current = {
    ...current,
    role: kind,
    linkToken,
    event,
    request: null
  };

  if (kind === 'coordinator') renderCoordinator();
  if (kind === 'transmitter') renderTransmitterIdentify();
  if (kind === 'listener') renderListener();
}

function joinPresence(role, requestId) {
  socket.emit('event:join', {
    eventId: current.event.id,
    role,
    requestId
  });
}

function formatEventDate(event) {
  if (!event.eventDate) return 'Nao informado';
  const [year, month, day] = event.eventDate.split('-');
  if (!year || !month || !day) return event.eventDate;
  return `${day}/${month}/${year}${event.eventTime ? ' as ' + event.eventTime : ''}`;
}

function eventPlace(event) {
  return [event.city, event.state].filter(Boolean).join(' - ') || 'Localidade nao informada';
}

function eventSummary() {
  const event = current.event;
  return `
    <div class="card stack">
      <span class="pill live">${event.live ? 'Ao vivo' : 'Encerrado'}</span>
      <h2>${escapeHtml(event.name)}</h2>
      <div class="stats">
        <div class="stat"><strong>${escapeHtml(event.type)}</strong><span>Tipo</span></div>
        <div class="stat"><strong>${escapeHtml(formatEventDate(event))}</strong><span>Data e horario</span></div>
        <div class="stat"><strong>${escapeHtml(eventPlace(event))}</strong><span>Cidade</span></div>
        <div class="stat"><strong>${escapeHtml(event.organizerName || 'Nao informado')}</strong><span>Responsavel</span></div>
        <div class="stat"><strong>Saida</strong><span>${escapeHtml(event.startLocation)}</span></div>
        <div class="stat"><strong>Destino</strong><span>${escapeHtml(event.destination)}</span></div>
      </div>
      <p class="muted">Coordenador: ${escapeHtml(event.coordinatorName)}${event.coordinatorPhone ? ' · ' + escapeHtml(event.coordinatorPhone) : ''}</p>
      ${event.notes ? `<p class="muted">Observacoes: ${escapeHtml(event.notes)}</p>` : ''}
    </div>
  `;
}

function eventEditForm(event) {
  return `
    <form id="event-edit-form" class="card form">
      <h3>Editar informacoes do evento</h3>
      <div class="field">
        <label for="edit-coordinatorName">Nome do coordenador</label>
        <input id="edit-coordinatorName" name="coordinatorName" autocomplete="name" required value="${escapeHtml(event.coordinatorName || '')}">
      </div>
      <div class="field">
        <label for="edit-coordinatorPhone">Telefone do coordenador</label>
        <input id="edit-coordinatorPhone" name="coordinatorPhone" inputmode="tel" autocomplete="tel" value="${escapeHtml(event.coordinatorPhone || '')}">
      </div>
      <div class="field">
        <label for="edit-name">Nome do evento</label>
        <input id="edit-name" name="name" required value="${escapeHtml(event.name || '')}">
      </div>
      <div class="field">
        <label for="edit-organizerName">Paroquia / grupo responsavel</label>
        <input id="edit-organizerName" name="organizerName" required value="${escapeHtml(event.organizerName || '')}">
      </div>
      <div class="field">
        <label for="edit-type">Tipo</label>
        <select id="edit-type" name="type">
          <option value="procissao" ${selected(event.type, 'procissao')}>Procissao</option>
          <option value="caminhada" ${selected(event.type, 'caminhada')}>Caminhada</option>
          <option value="outro" ${selected(event.type, 'outro')}>Outro</option>
        </select>
      </div>
      <div class="field">
        <label for="edit-city">Cidade</label>
        <input id="edit-city" name="city" required value="${escapeHtml(event.city || '')}">
      </div>
      <div class="field">
        <label for="edit-state">Estado</label>
        <input id="edit-state" name="state" maxlength="2" value="${escapeHtml(event.state || '')}">
      </div>
      <div class="field">
        <label for="edit-eventDate">Data</label>
        <input id="edit-eventDate" name="eventDate" type="date" required value="${escapeHtml(event.eventDate || '')}">
      </div>
      <div class="field">
        <label for="edit-eventTime">Horario de inicio</label>
        <input id="edit-eventTime" name="eventTime" type="time" required value="${escapeHtml(event.eventTime || '')}">
      </div>
      <div class="field">
        <label for="edit-startLocation">Local de saida</label>
        <input id="edit-startLocation" name="startLocation" required value="${escapeHtml(event.startLocation || '')}">
      </div>
      <div class="field">
        <label for="edit-destination">Destino</label>
        <input id="edit-destination" name="destination" required value="${escapeHtml(event.destination || '')}">
      </div>
      <div class="field">
        <label for="edit-notes">Observacoes para equipe</label>
        <textarea id="edit-notes" name="notes" rows="3">${escapeHtml(event.notes || '')}</textarea>
      </div>
      <button class="btn" type="submit">Salvar alteracoes</button>
    </form>
  `;
}

function renderCoordinator() {
  joinPresence('coordinator');
  const links = current.event.links;

  renderShell(`
    <section class="grid">
      <div class="stack">
        ${eventSummary()}
        ${eventEditForm(current.event)}
        <div class="card">
          <h3>Links do evento</h3>
          ${copyLinkBox('Link do coordenador', linkFor('coordinator', links.coordinator))}
          ${copyLinkBox('Link para transmissores', linkFor('transmitter', links.transmitter))}
          ${copyLinkBox('Link dos ouvintes', linkFor('listener', links.listener))}
        </div>
      </div>

      <div class="stack">
        <div class="card">
          <h3>Painel do coordenador</h3>
          <div class="stats">
            <div class="stat"><strong id="listener-count">0</strong><span>Ouvintes</span></div>
            <div class="stat"><strong id="transmitter-count">0</strong><span>Transmissores online</span></div>
            <div class="stat"><strong id="pending-count">0</strong><span>Aguardando</span></div>
          </div>
          <div class="actions" style="margin-top:16px">
            <button class="btn secondary" id="coordinator-listen">Ouvir sala</button>
            <button class="btn danger" id="end-event">Encerrar</button>
          </div>
        </div>

        <div class="card">
          <h3>Pedidos de transmissao</h3>
          <div id="transmitter-list" class="list"></div>
        </div>
      </div>
    </section>
  `);

  bindCopyButtons();
  bindCoordinatorActions();
  bindEventEditForm();
  updateCoordinatorStatus();
}

function bindEventEditForm() {
  document.querySelector('#event-edit-form').addEventListener('submit', async event => {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    try {
      const updated = await api(`/api/events/${current.event.id}`, {
        method: 'PUT',
        body: JSON.stringify({
          ...Object.fromEntries(form.entries()),
          adminToken: current.linkToken
        })
      });
      current.event = updated;
      renderCoordinator();
      toast('Informacoes do evento atualizadas.');
    } catch (error) {
      toast(error.message);
    }
  });
}

function copyLinkBox(label, link) {
  return `
    <div class="field" style="margin-top:12px">
      <label>${label}</label>
      <div class="link-box">
        <code>${escapeHtml(link)}</code>
        <button class="btn secondary copy-btn" data-link="${escapeHtml(link)}" type="button">Copiar</button>
      </div>
    </div>
  `;
}

function bindCopyButtons() {
  document.querySelectorAll('.copy-btn').forEach(button => {
    button.addEventListener('click', async () => {
      await navigator.clipboard.writeText(button.dataset.link);
      toast('Link copiado.');
    });
  });
}

function bindCoordinatorActions() {
  document.querySelector('#coordinator-listen').addEventListener('click', () => connectLiveKit('coordinator'));
  document.querySelector('#end-event').addEventListener('click', async () => {
    if (!confirm('Encerrar esta transmissao para todos?')) return;
    await api(`/api/events/${current.event.id}/end`, {
      method: 'POST',
      body: JSON.stringify({ adminToken: current.linkToken })
    });
    toast('Transmissao encerrada.');
  });
}

function updateCoordinatorStatus() {
  if (current.role !== 'coordinator') return;

  const transmitters = current.status.transmitters || current.event.transmitters || [];
  const pending = transmitters.filter(item => item.status === 'pending').length;

  setText('#listener-count', current.status.listeners || 0);
  setText('#transmitter-count', current.status.transmittersOnline || 0);
  setText('#pending-count', pending);

  const list = document.querySelector('#transmitter-list');
  if (!list) return;

  if (transmitters.length === 0) {
    list.innerHTML = '<p class="muted">Nenhum transmissor solicitou acesso ainda.</p>';
    return;
  }

  list.innerHTML = transmitters.map(item => `
    <div class="item">
      <div>
        <strong>${escapeHtml(item.name)}</strong>
        <small>${escapeHtml(item.role)}</small>
      </div>
      <div class="actions">
        <span class="status ${escapeHtml(item.status)}">${labelStatus(item.status)}</span>
        ${item.status === 'pending' ? `
          <button class="btn success decision" data-id="${item.id}" data-decision="approve">Autorizar</button>
          <button class="btn danger decision" data-id="${item.id}" data-decision="reject">Recusar</button>
        ` : ''}
      </div>
    </div>
  `).join('');

  document.querySelectorAll('.decision').forEach(button => {
    button.addEventListener('click', () => decideTransmitter(button.dataset.id, button.dataset.decision));
  });
}

async function decideTransmitter(requestId, decision) {
  try {
    const updated = await api(`/api/events/${current.event.id}/transmitters/${requestId}/${decision}`, {
      method: 'POST',
      body: JSON.stringify({ adminToken: current.linkToken })
    });
    current.status.transmitters = current.status.transmitters.map(item => item.id === updated.id ? updated : item);
    updateCoordinatorStatus();
    toast(decision === 'approve' ? 'Transmissor autorizado.' : 'Transmissor recusado.');
  } catch (error) {
    toast(error.message);
  }
}

function renderTransmitterIdentify() {
  renderShell(`
    <section class="grid">
      ${eventSummary()}
      <form id="request-form" class="card form">
        <h2>Identifique-se para transmitir</h2>
        <div class="notice">
          Depois de enviar, o coordenador precisa autorizar seu acesso antes do microfone ser liberado.
        </div>
        <div class="field">
          <label for="name">Seu nome</label>
          <input id="name" name="name" autocomplete="name" required placeholder="Ex: Ana Paula">
        </div>
        <div class="field">
          <label for="role">Funcao na procissao</label>
          <input id="role" name="role" required placeholder="Ex: Canto, violao, leitura, coordenacao">
        </div>
        <button class="btn" type="submit">Pedir autorizacao</button>
      </form>
    </section>
  `);

  document.querySelector('#request-form').addEventListener('submit', async event => {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    try {
      const request = await api(`/api/events/${current.event.id}/transmitters/request`, {
        method: 'POST',
        body: JSON.stringify({
          ...Object.fromEntries(form.entries()),
          linkToken: current.linkToken
        })
      });
      current.request = request;
      renderTransmitterWaiting();
    } catch (error) {
      toast(error.message);
    }
  });
}

function renderTransmitterWaiting() {
  joinPresence('transmitter', current.request.id);
  renderShell(`
    <section class="grid">
      ${eventSummary()}
      <div class="card stack">
        <span class="pill">Aguardando coordenador</span>
        <h2>${escapeHtml(current.request.name)}</h2>
        <p class="lead">Sua solicitacao foi enviada. Mantenha esta pagina aberta para receber a autorizacao.</p>
        <div class="audio-meter paused">${meterBars()}</div>
        <p class="muted">Funcao: ${escapeHtml(current.request.role)}</p>
      </div>
    </section>
  `);
}

function renderTransmitterLive() {
  renderShell(`
    <section class="grid">
      ${eventSummary()}
      <div class="card stack">
        <span class="pill live">Transmissor autorizado</span>
        <h2>${escapeHtml(current.request.name)}</h2>
        <p class="lead">Controle o microfone daqui. Quando ligado, sua voz, canto ou instrumento entra na radio ao vivo.</p>
        <div id="tx-meter" class="audio-meter paused">${meterBars()}</div>
        <div class="actions">
          <button class="btn" id="connect-transmitter">Conectar ao radio</button>
          <button class="btn secondary" id="toggle-mic" disabled>Ligar microfone</button>
        </div>
        <p id="tx-state" class="muted">Microfone desconectado.</p>
      </div>
    </section>
  `);

  document.querySelector('#connect-transmitter').addEventListener('click', () => connectLiveKit('transmitter'));
  document.querySelector('#toggle-mic').addEventListener('click', toggleMic);
}

function renderListener() {
  joinPresence('listener');
  renderShell(`
    <section class="listener-stage">
      <div class="card stack" style="width:min(680px, 100%)">
        <span class="pill live">Ouvinte conectado</span>
        <h2>${escapeHtml(current.event.name)}</h2>
        <p class="lead">
          ${escapeHtml(current.event.startLocation)} ate ${escapeHtml(current.event.destination)}
          <br>${escapeHtml(formatEventDate(current.event))} · ${escapeHtml(eventPlace(current.event))}
        </p>
        <div class="big-count" id="listener-live-count">0</div>
        <p class="muted">ouvintes acompanhando agora</p>
        <div id="listener-meter" class="audio-meter paused">${meterBars()}</div>
        <button class="btn" id="start-listening">Entrar no audio ao vivo</button>
        <p id="listener-state" class="muted">A pagina ja contou sua presenca. Toque no botao para liberar audio no navegador.</p>
        <div class="notice">
          Durante o teste, mantenha esta tela aberta. O app tenta manter a tela acordada enquanto voce ouve para evitar que o navegador interrompa o audio.
        </div>
      </div>
    </section>
  `);

  document.querySelector('#start-listening').addEventListener('click', () => connectLiveKit('listener'));
  setText('#listener-live-count', current.status.listeners || 1);
}

function meterBars() {
  return Array.from({ length: 24 }, (_, index) => {
    const height = 12 + ((index * 11) % 44);
    return `<span style="--h:${height}px;animation-delay:${index * 0.035}s"></span>`;
  }).join('');
}

async function connectLiveKit(mode) {
  try {
    if (current.room) await current.room.disconnect();

    const payload = {
      mode,
      linkToken: current.linkToken,
      transmitterId: current.request?.id
    };
    const credentials = await api(`/api/events/${current.event.id}/livekit-token`, {
      method: 'POST',
      body: JSON.stringify(payload)
    });

    const room = new Room({
      adaptiveStream: true,
      dynacast: true
    });

    room.on(RoomEvent.TrackSubscribed, track => {
      if (track.kind !== Track.Kind.Audio) return;
      track.attach(remoteAudio);
      remoteAudio.play().catch(() => {});
      animateAudio(true);
    });

    room.on(RoomEvent.TrackUnsubscribed, track => {
      track.detach(remoteAudio);
    });

    room.on(RoomEvent.Disconnected, () => {
      animateAudio(false);
      current.room = null;
      releaseWakeLock();
      if ('mediaSession' in navigator) navigator.mediaSession.playbackState = 'none';
    });

    await room.connect(credentials.livekitUrl, credentials.token);
    await room.startAudio();
    current.room = room;
    setupMediaSession(current.event, mode);

    if (mode === 'transmitter') {
      document.querySelector('#toggle-mic').disabled = false;
      setText('#tx-state', 'Conectado. Microfone ainda desligado.');
      toast('Conectado ao LiveKit.');
    }

    if (mode === 'listener') {
      await requestWakeLock();
      await remoteAudio.play().catch(() => {});
      setText('#listener-state', 'Ouvindo ao vivo.');
      document.querySelector('#start-listening').disabled = true;
      toast('Audio conectado.');
    }

    if (mode === 'coordinator') {
      toast('Coordenador conectado para escuta.');
    }
  } catch (error) {
    toast(error.message);
  }
}

async function toggleMic() {
  if (!current.room) return;
  try {
    current.micOn = !current.micOn;
    await current.room.localParticipant.setMicrophoneEnabled(current.micOn);
    document.querySelector('#toggle-mic').textContent = current.micOn ? 'Desligar microfone' : 'Ligar microfone';
    setText('#tx-state', current.micOn ? 'Microfone ligado e transmitindo.' : 'Microfone desligado.');
    document.querySelector('#tx-meter').classList.toggle('paused', !current.micOn);
  } catch (error) {
    current.micOn = false;
    toast(error.message);
  }
}

function animateAudio(on) {
  document.querySelectorAll('#listener-meter, #tx-meter').forEach(el => {
    if (el) el.classList.toggle('paused', !on);
  });
}

function labelStatus(status) {
  return {
    pending: 'Pendente',
    approved: 'Autorizado',
    rejected: 'Recusado'
  }[status] || status;
}

function setText(selector, value) {
  const el = document.querySelector(selector);
  if (el) el.textContent = value;
}

socket.on('event:status', status => {
  if (!current.event || status.eventId !== current.event.id) return;
  current.status = status;

  if (current.role === 'coordinator') updateCoordinatorStatus();
  if (current.role === 'listener') setText('#listener-live-count', status.listeners);
});

socket.on('event:updated', event => {
  if (!current.event || event.id !== current.event.id) return;
  current.event = {
    ...current.event,
    ...event
  };

  if (current.role === 'coordinator') renderCoordinator();
  if (current.role === 'transmitter') {
    if (current.request?.status === 'approved') renderTransmitterLive();
    else if (current.request) renderTransmitterWaiting();
    else renderTransmitterIdentify();
  }
  if (current.role === 'listener') renderListener();
});

socket.on('transmitter:requested', request => {
  if (current.role !== 'coordinator') return;
  const exists = current.status.transmitters.some(item => item.id === request.id);
  if (!exists) current.status.transmitters = [...current.status.transmitters, request];
  updateCoordinatorStatus();
  toast(`Novo pedido: ${request.name}`);
});

socket.on('transmitter:updated', transmitter => {
  if (current.role !== 'coordinator') return;
  current.status.transmitters = current.status.transmitters.map(item => item.id === transmitter.id ? transmitter : item);
  updateCoordinatorStatus();
});

socket.on('transmitter:approved', transmitter => {
  if (!current.request || current.request.id !== transmitter.id) return;
  current.request = transmitter;
  renderTransmitterLive();
  toast('Coordenador autorizou sua transmissao.');
});

socket.on('transmitter:rejected', transmitter => {
  if (!current.request || current.request.id !== transmitter.id) return;
  current.request = transmitter;
  renderShell(`
    <section class="grid">
      ${eventSummary()}
      <div class="card stack">
        <span class="pill">Acesso recusado</span>
        <h2>${escapeHtml(transmitter.name)}</h2>
        <p class="lead">O coordenador recusou esta solicitacao de transmissao.</p>
      </div>
    </section>
  `);
});

socket.on('event:ended', () => {
  toast('A transmissao foi encerrada pelo coordenador.');
  if (current.room) current.room.disconnect();
});

async function boot() {
  try {
    appConfig = await api('/api/config');
    const [prefix, linkToken] = pathParts;
    if (!prefix) return renderHome();

    const kind = { c: 'coordinator', t: 'transmitter', o: 'listener' }[prefix];
    if (!kind || !linkToken) return renderHome();

    await loadByLink(kind, linkToken);
  } catch (error) {
    renderShell(`
      <div class="card stack">
        <h2>Link nao encontrado</h2>
        <p class="lead">${escapeHtml(error.message)}</p>
        <a class="btn" href="/">Criar novo evento</a>
      </div>
    `);
  }
}

boot();
