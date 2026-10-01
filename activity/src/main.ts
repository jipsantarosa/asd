import { DiscordSDK } from '@discord/embedded-app-sdk';
import { ApiError, api, auth, onReauth } from './api';
import { farmView } from './farm';
import { fishView } from './fish';
import { topView } from './top';
import { $, esc, reportError, type View } from './ui';

type Mode = 'granja' | 'pesca' | 'top';
const VIEWS: Record<Mode, View> = { granja: farmView, pesca: fishView, top: topView };
let mode: Mode = 'granja';
let me = { name: '' };
let sdk: DiscordSDK;
let clientId = '';

function shell(): void {
  $('#app').innerHTML = `
    <header class="topbar">
      <div class="who"><div class="avatar" id="avatar"></div><div><div class="name" id="name"></div><div class="sub">El Valle</div></div></div>
      <nav class="modes" id="modes">
        <button data-mode="granja">🌾 <span>Granja</span></button>
        <button data-mode="pesca">🎣 <span>Pesca</span></button>
        <button data-mode="top">🏆 <span>Top</span></button>
      </nav>
      <div class="coins" id="coins"></div>
    </header>
    <main id="view"></main>`;
  $('#name').textContent = me.name;
  $('#avatar').textContent = (me.name.trim()[0] ?? '?').toUpperCase();
  $('#modes').onclick = (e) => {
    const m = (e.target as HTMLElement).closest('button')?.dataset.mode as Mode | undefined;
    if (m && m !== mode) void switchTo(m);
  };
}

async function switchTo(m: Mode): Promise<void> {
  mode = m;
  document.querySelectorAll<HTMLButtonElement>('#modes button').forEach((b) => b.classList.toggle('active', b.dataset.mode === m));
  const root = $('#view');
  VIEWS[m].mount(root);
  try {
    await VIEWS[m].load();
  } catch (err) {
    reportError(err);
  }
}

async function authenticate(): Promise<void> {
  const { code } = await sdk.commands.authorize({ client_id: clientId, response_type: 'code', state: '', prompt: 'none', scope: ['identify'] });
  const r = await api<{ access_token: string; session: string; user: { id: string; name: string } }>('/token', { code });
  auth.session = r.session;
  await sdk.commands.authenticate({ access_token: r.access_token });
  me = { name: r.user.name };
}

function fatal(text: string): void {
  $('#app').innerHTML = `<div class="splash"><div class="splash-sprout">🥀</div><p>${esc(text)}</p></div>`;
}

let stage = 'cargar la configuración';

async function boot(): Promise<void> {
  try {
    clientId = (await api<{ clientId: string }>('/config')).clientId;
    stage = 'conectar con Discord';
    sdk = new DiscordSDK(clientId);
    await sdk.ready();
    if (!sdk.guildId) {
      fatal('El Valle se juega en servidores: abrí la actividad desde un canal de un servidor donde esté el bot.');
      return;
    }
    auth.guildId = sdk.guildId;
    $('#splash-text').textContent = 'Conectando con tu cuenta…';
    onReauth(authenticate);
    stage = 'iniciar sesión';
    await authenticate();
    stage = 'cargar el juego';
    shell();
    await switchTo('granja');
    setInterval(() => VIEWS[mode].tick(), 250);
    // Mantiene sincronizado lo que hagas desde los botones del bot.
    setInterval(() => void VIEWS[mode].load().catch(() => undefined), 30_000);
    document.addEventListener('visibilitychange', () => {
      if (!document.hidden) void VIEWS[mode].load().catch(() => undefined);
    });
  } catch (err) {
    const detail = err instanceof Error ? err.message : typeof err === 'object' && err ? JSON.stringify(err) : String(err);
    fatal(err instanceof ApiError && err.status === 403
      ? 'No se pudo verificar que seas miembro de este servidor, o el bot no está en él.'
      : `No se pudo iniciar El Valle (paso: ${stage}). Detalle: ${detail}`);
    console.error(err);
  }
}

void boot();
