// Mensajes automáticos en Discord, desde tu cuenta y sin tocar tus ventanas (lo usa auto-mensajes.bat).
//
//   - "xmine 2"        cada 2 minutos
//   - "xfish 2"        5 segundos después de cada xmine
//   - "xpet explore 2" cada 45 minutos
//
// Abre una ventana aparte de Microsoft Edge (con su propio perfil) en el canal y escribe
// ahí como si fuera el teclado. Esa ventana se puede minimizar: los mensajes salen igual
// aunque estés usando otra cosa o la PC esté bloqueada. No usa token: la primera vez
// iniciás sesión en Discord en esa ventana y queda guardada.
//
// Para detenerlo, cerrá la ventana negra (o la de Discord).

import { chromium } from 'playwright-core';
import { spawn } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';

// ======================= CONFIGURACIÓN =======================
// Canal: en Discord, clic derecho en el canal > "Copiar enlace del canal".
const CANAL = 'https://discord.com/channels/1536949928872378438/1543948984886763611';

// texto: lo que se escribe. cadaMinutos: cada cuánto se repite.
// primeraVez: a los cuántos segundos de arrancar se manda la primera vez.
const MENSAJES = [
  { texto: 'xmine 2', cadaMinutos: 2, primeraVez: 0 },
  { texto: 'xfish 2', cadaMinutos: 2, primeraVez: 5 },
  { texto: 'xpet explore 2', cadaMinutos: 45, primeraVez: 10 },
];

// Nunca se mandan dos mensajes con menos de estos segundos de diferencia.
const SEPARACION_MINIMA = 5;

// Si un mensaje no se pudo enviar, se vuelve a intentar a los tantos segundos.
const REINTENTO = 30;

// Navegador para la ventana aparte: 'msedge' (viene con Windows) o 'chrome'.
const NAVEGADOR = 'msedge';
// =============================================================

// Perfil de esa ventana (tiene tu sesión de Discord): fuera de esta carpeta, para no compartirlo sin querer.
const PERFIL = path.join(process.env.LOCALAPPDATA || os.homedir(), 'auto-mensajes-discord');
// La caja para escribir mensajes del canal.
const CAJA = '[role="textbox"][data-slate-editor="true"]';

const hora = (ms = Date.now()) => new Date(ms).toLocaleTimeString('es-AR', { hour12: false });
const log = (texto) => console.log(`[${hora()}] ${texto}`);

// Mientras corre, Windows no se suspende (la pantalla sí se puede apagar o bloquear).
function mantenerDespierta() {
  if (process.platform !== 'win32') return;
  const ps = `Add-Type -Namespace W -Name P -MemberDefinition '[DllImport("kernel32.dll")] public static extern uint SetThreadExecutionState(uint f);'
[void][W.P]::SetThreadExecutionState(2147483649) # ES_CONTINUOUS | ES_SYSTEM_REQUIRED
while ($true) { Start-Sleep 3600 }`;
  const hijo = spawn('powershell', ['-NoProfile', '-EncodedCommand', Buffer.from(ps, 'utf16le').toString('base64')], {
    stdio: 'ignore',
    windowsHide: true,
  });
  hijo.on('error', () => {});
  process.on('exit', () => hijo.kill());
}

async function abrirNavegador() {
  let error;
  for (const channel of new Set([NAVEGADOR, 'msedge', 'chrome'])) {
    try {
      return await chromium.launchPersistentContext(PERFIL, { channel, headless: false, viewport: null });
    } catch (e) {
      error = e;
    }
  }
  throw new Error(`No pude abrir Microsoft Edge ni Google Chrome.\n${error?.message ?? ''}`);
}

let contexto;
let pagina;

async function obtenerPagina() {
  if (!pagina || pagina.isClosed()) pagina = contexto.pages()[0] ?? (await contexto.newPage());
  return pagina;
}

// Deja la ventana en el canal, con la caja para escribir lista. La primera vez espera a que inicies sesión.
async function esperarCanal() {
  const page = await obtenerPagina();
  const desde = Date.now();
  let avisoSesion = false;
  let avisoCaja = false;
  for (;;) {
    if (await page.locator(CAJA).count()) return page;
    const url = page.url();
    if (/discord\.com\/(login|register)/.test(url)) {
      if (!avisoSesion) {
        log('Iniciá sesión en Discord en la ventana que se abrió (podés escanear el QR con el celular). Te espero.');
        avisoSesion = true;
      }
    } else if (!url.startsWith(CANAL)) {
      try {
        await page.goto(CANAL);
      } catch (e) {
        log(`No pude abrir el canal: ${e.message.split('\n')[0]}`);
      }
    } else if (!avisoCaja && !avisoSesion && Date.now() - desde > 60_000) {
      log('No aparece la caja para escribir en el canal: ¿tenés acceso y permiso para escribir ahí?');
      avisoCaja = true;
    }
    await sleep(2000);
  }
}

// Devuelve true si el mensaje salió.
async function enviar(texto) {
  const page = await esperarCanal();
  await page.locator(CAJA).first().focus();
  // Si quedó algo escrito en la caja, se reemplaza.
  await page.keyboard.press('Control+A');
  await page.keyboard.press('Backspace');
  await page.keyboard.type(texto, { delay: 30 });
  await page.keyboard.press('Enter');

  // Enviado = el texto ya no está en la caja.
  try {
    await page.waitForFunction(
      ({ caja, texto }) => !document.querySelector(caja)?.textContent.includes(texto),
      { caja: CAJA, texto },
      { timeout: 5000, polling: 250 },
    );
    log(`Enviado: ${texto}`);
    return true;
  } catch {
    log(`No se envió "${texto}": sigue en la caja (¿modo lento o sin permiso?). Reintento en ${REINTENTO} s.`);
    return false;
  }
}

async function main() {
  console.log('Mensajes automáticos en Discord');
  for (const m of MENSAJES) console.log(`  ${m.texto.padEnd(20)} cada ${m.cadaMinutos} min`);
  console.log(`Canal: ${CANAL}\n`);

  mantenerDespierta();
  log('Abriendo la ventana de Discord...');
  contexto = await abrirNavegador();
  contexto.on('close', () => {
    log('Se cerró la ventana de Discord: me detengo.');
    process.exit(0);
  });

  await esperarCanal();
  log('Listo. Podés minimizar la ventana de Discord, pero no la cierres.');

  const inicio = performance.now();
  const ahora = () => (performance.now() - inicio) / 1000;
  const tareas = MENSAJES.map((m, orden) => ({ ...m, cada: m.cadaMinutos * 60, proximo: m.primeraVez, orden }));
  let ultimoEnvio = -Infinity;

  for (;;) {
    // El que toca primero (si empatan, el que está antes en la lista).
    const t = tareas.reduce((a, b) => (b.proximo < a.proximo ? b : a));
    const cuando = Math.max(t.proximo, ultimoEnvio + SEPARACION_MINIMA);
    const falta = cuando - ahora();
    if (falta > 1) log(`Próximo: "${t.texto}" a las ${hora(Date.now() + falta * 1000)}`);
    if (falta > 0) await sleep(falta * 1000);

    let enviado = false;
    try {
      enviado = await enviar(t.texto);
    } catch (e) {
      log(`Error al enviar "${t.texto}": ${e.message.split('\n')[0]}. Reintento en ${REINTENTO} s.`);
    }

    // Cada mensaje vuelve a tocar recién cuando pasa su tiempo completo desde que se mandó.
    ultimoEnvio = ahora();
    t.proximo = ultimoEnvio + (enviado ? t.cada : Math.min(REINTENTO, t.cada));
  }
}

main().catch((e) => {
  console.error(`\n[ERROR] ${e.message}`);
  process.exit(1);
});
