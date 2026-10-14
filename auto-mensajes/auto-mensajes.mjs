// Mensajes automáticos en Discord, desde tu cuenta y sin tocar tus ventanas (lo usa auto-mensajes.bat).
//
//   - "xmine 3"        cada 5 minutos (la espera de Nekotina)
//   - "xfish 3"        5 segundos después de cada xmine
//   - "xpet explore 1" cada 45 minutos
//
// Abre Discord en Microsoft Edge (con su propio perfil, aparte del tuyo) en el canal y
// escribe ahí como si fuera el teclado. No usa token: la primera vez se abre una ventana
// para que inicies sesión; después queda guardada y Discord sigue abierto sin ventana,
// así que no hace falta tener nada a la vista (ni la PC desbloqueada).
//
// Lee lo que contesta Nekotina: si pide esperar, espera justo hasta la hora que dice; si
// dice que te falta algo (pico, caña...) o pide verificar que sos humano, te avisa con un
// sonido y pausa. Usa solo los Haste Scroll mientras te queden: con Haste manda xmine y
// xfish con la mitad de espera, y cuando se terminan sigue normal cada 5 minutos.
//
// Para detenerlo, cerrá la ventana negra.

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
// haste: si el Haste Scroll le baja la espera.
// Si Nekotina contesta que esperes, el script espera justo hasta la hora que dice.
const MENSAJES = [
  { texto: 'xmine 3', cadaMinutos: 5, primeraVez: 0, haste: true },
  { texto: 'xfish 3', cadaMinutos: 5, primeraVez: 5, haste: true },
  { texto: 'xpet explore 1', cadaMinutos: 45, primeraVez: 10 },
];

// Buffs que el script usa solo, uno atrás del otro mientras te queden. Cuando Nekotina dice
// que no tenés más, sigue normal y vuelve a probar cada hora por si conseguiste.
// haste: true = Haste Scroll: mientras dura, mine y fish esperan la mitad (2,5 minutos).
// Para que no use uno, borrá su línea o poné // adelante.
const BUFFS = [
  { comando: 'xuse 600', minutos: 30, haste: true }, // Haste Scroll
  // { comando: 'xuse 628', minutos: 720 },          // Pooky Shiny: EXP Boost por 12 horas
  // { comando: 'xuse 614', minutos: 60 },           // Pez Shiny (Especial): EXP Boost por 1 hora
];

// Nunca se mandan dos mensajes con menos de estos segundos de diferencia.
const SEPARACION_MINIMA = 5;

// Si un mensaje no se pudo enviar, se vuelve a intentar a los tantos segundos.
const REINTENTO = 30;

// Segundos de más sobre cadaMinutos, para no llegar justo antes de que termine la espera del bot.
const MARGEN = 10;

// Bot que responde los comandos: el script lee sus respuestas.
const BOT = 'Nekotina';

// Si el bot dice que te falta algo para un comando (pico, caña...), ese comando se pausa estos
// minutos. Si pide verificar que sos humano, se pausa todo.
const PAUSA_PROBLEMA = 10;

// Navegador: 'msedge' (viene con Windows) o 'chrome'.
const NAVEGADOR = 'msedge';

// true: después de iniciar sesión, Discord sigue abierto sin ventana.
// false: queda la ventana de Discord a la vista (se puede minimizar, pero no cerrar).
const SIN_VENTANA = true;
// =============================================================

// Perfil de esa ventana (tiene tu sesión de Discord): fuera de esta carpeta, para no compartirlo sin querer.
const PERFIL = path.join(process.env.LOCALAPPDATA || os.homedir(), 'auto-mensajes-discord');
// La caja para escribir mensajes del canal, y cada mensaje del chat.
const CAJA = '[role="textbox"][data-slate-editor="true"]';
const MENSAJE = 'li[id^="chat-messages-"]';

// Cómo se reconoce cada respuesta del bot.
const ESPERA = /descans|cansad|podr[aá]s?|vuelve|volv[eé]|de nuevo|esper|cooldown/i;
const PROBLEMA = /no (tienes|ten[eé]s)|necesit[aá]s|se (te )?rompi[oó]|est[aá] rot[oa]|no (puedes|pod[eé]s)/i;
const VERIFICACION = /captcha|verific|humano|anti-?bot/i;

// Haste: cuánto dura y cuánto queda la espera. Si lo usás vos en el canal, el script también lo nota.
const HASTE_MINUTOS = 30;
const HASTE_FACTOR = 0.5;
// Cada cuántos segundos se revisa el canal mientras se espera (para notar un Haste).
const REVISAR = 20;
// Si no quedan buffs (o no se confirmó), se vuelve a probar a los tantos minutos.
const REINTENTO_BUFF = 60;

const hora = (ms = Date.now()) => new Date(ms).toLocaleTimeString('es-AR', { hour12: false });
const log = (texto) => console.log(`[${hora()}] ${texto}`);
// Con sonido, para lo que tenés que ver vos.
const alerta = (texto) => {
  process.stdout.write('\x07');
  log(`[!] ${texto}`);
};

// Cuándo se puede volver a usar el comando, según la respuesta del bot
// ("Podrás regresar a las minas a las 10:24 (en 5 minutos)"). null si no dice.
function cuandoVuelve(texto, ahora = new Date()) {
  let cuando = null;
  const hm = texto.match(/a las (\d{1,2}):(\d{2})\s*([ap])?/i);
  if (hm) {
    let h = Number(hm[1]);
    if (hm[3]?.toLowerCase() === 'p' && h < 12) h += 12;
    if (hm[3]?.toLowerCase() === 'a' && h === 12) h = 0;
    // Hasta el final de ese minuto, porque la hora no trae segundos.
    cuando = new Date(ahora);
    cuando.setHours(h, Number(hm[2]), 59, 0);
    if (cuando < ahora - 3600_000) cuando.setDate(cuando.getDate() + 1); // es después de la medianoche
  }
  const en = texto.match(/en (\d+|un|una|unos) (segundo|minuto|hora)s?/i);
  if (en) {
    const unidad = { segundo: 1000, minuto: 60_000, hora: 3600_000 }[en[2].toLowerCase()];
    const palabra = en[1].toLowerCase();
    const n = /^\d+$/.test(palabra) ? Number(palabra) : palabra === 'unos' ? (unidad === 1000 ? 30 : 2) : 1;
    const relativo = new Date(ahora.getTime() + n * unidad);
    if (!cuando || relativo > cuando) cuando = relativo;
  }
  return cuando;
}

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

async function abrirNavegador(sinVentana) {
  const opciones = sinVentana
    ? { headless: true, viewport: { width: 1280, height: 800 } }
    : { headless: false, viewport: null };
  let error;
  for (const channel of new Set([NAVEGADOR, 'msedge', 'chrome'])) {
    try {
      return await chromium.launchPersistentContext(PERFIL, { channel, ...opciones });
    } catch (e) {
      error = e;
    }
  }
  throw new Error(`No pude abrir Microsoft Edge ni Google Chrome.\n${error?.message ?? ''}`);
}

// Discord pidió iniciar sesión estando sin ventana (ahí no se puede).
class SinSesion extends Error {
  constructor() {
    super('Discord pide iniciar sesión otra vez. Si se repite, poné SIN_VENTANA = false en auto-mensajes.mjs.');
  }
}

let contexto;
let pagina;
let oculto = false;
let hasteHasta = 0; // hasta cuándo dura el Haste (Date.now())

async function abrir(sinVentana) {
  const c = await abrirNavegador(sinVentana);
  contexto = c;
  pagina = null;
  oculto = sinVentana;
  c.on('close', () => {
    if (contexto !== c) return; // la cerré yo para cambiar de modo
    log('Se cerró Discord: me detengo.');
    process.exit(0);
  });
}

async function cerrar() {
  const c = contexto;
  contexto = null;
  await c.close();
}

// Abre Discord en el canal. Si no hay sesión, muestra la ventana para iniciarla y después
// (con SIN_VENTANA) la cierra y sigue sin ventana.
async function conectar() {
  if (SIN_VENTANA) {
    await abrir(true);
    try {
      await esperarCanal();
      return;
    } catch (e) {
      if (!(e instanceof SinSesion)) throw e;
      await cerrar();
    }
  }
  await abrir(false);
  await esperarCanal();
  if (SIN_VENTANA) {
    log('Sesión iniciada: cierro la ventana y sigo sin ventana.');
    await cerrar();
    await abrir(true);
    await esperarCanal();
  }
}

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
      if (oculto) throw new SinSesion();
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

// Anota un Haste que empieza ahora (o en `desde`). Devuelve true si alarga el que había.
function anotarHaste(desde = Date.now()) {
  const hasta = desde + HASTE_MINUTOS * 60_000;
  if (hasta <= hasteHasta || hasta <= Date.now()) return false;
  hasteHasta = hasta;
  log(`Haste activo hasta las ${hora(hasteHasta)}: mientras dura, mine y fish esperan la mitad.`);
  return true;
}

// Busca en el canal si el bot confirmó un Haste (respondiendo a un "use") hace menos de 30
// minutos, por ejemplo si lo usaste vos. Devuelve true si encontró uno nuevo.
async function revisarHaste() {
  const page = await obtenerPagina();
  const mensajes = await page.$$eval(MENSAJE, (lis) =>
    lis.map((li) => {
      const id = li.id.split('-').pop();
      const propio = [`#message-content-${id}`, `#message-accessories-${id}`]
        .map((sel) => li.querySelector(sel)?.innerText ?? '')
        .join('\n');
      return {
        id,
        autor: li.querySelector('[id^="message-username-"]')?.textContent ?? '',
        propio,
        cita: li.innerText.replace(propio, ''),
      };
    }),
  );
  let nuevo = false;
  for (const { id, autor, propio, cita } of mensajes) {
    if (!/^\d+$/.test(id) || !autor.includes(BOT) || !/use/i.test(cita)) continue;
    if (!/haste/i.test(propio) || PROBLEMA.test(propio)) continue;
    // El ID de cada mensaje de Discord dice cuándo se mandó.
    if (anotarHaste(Number((BigInt(id) >> 22n) + 1420070400000n))) nuevo = true;
  }
  return nuevo;
}

// Espera la respuesta del bot que cita nuestro mensaje y devuelve su texto, o null si no contesta.
async function leerRespuesta(page, texto, antes) {
  const hasta = Date.now() + 15_000;
  while (Date.now() < hasta) {
    const respuesta = await page.$$eval(
      MENSAJE,
      (mensajes, { antes, bot, texto }) => {
        for (const li of mensajes) {
          if (antes.includes(li.id) || !li.innerText.includes(texto)) continue;
          const autor = li.querySelector('[id^="message-username-"]')?.textContent ?? '';
          if (!autor.includes(bot)) continue;
          // Solo lo que dice el bot (el texto y los recuadros), sin la cita de nuestro mensaje.
          const id = li.id.split('-').pop();
          const partes = [`#message-content-${id}`, `#message-accessories-${id}`].map(
            (sel) => li.querySelector(sel)?.innerText ?? '',
          );
          return partes.join('\n').trim() || li.innerText;
        }
        return null;
      },
      { antes, bot: BOT, texto },
    );
    if (respuesta) return respuesta;
    await sleep(500);
  }
  return null;
}

// Manda el mensaje y lee qué contestó el bot. Devuelve:
//   { estado: 'ok' }               salió y el bot contestó normal (o no contestó)
//   { estado: 'espera', cuando }   el bot pidió esperar hasta `cuando`
//   { estado: 'problema' }         el bot dijo que falta algo (pico, caña...)
//   { estado: 'verificacion' }     el bot pide verificar que sos humano
//   { estado: 'no-enviado' }       el mensaje no salió
// También devuelve `respuesta`, el texto del bot.
async function enviar(texto, esBuff = false) {
  const page = await esperarCanal();
  const antes = await page.$$eval(MENSAJE, (mensajes) => mensajes.map((li) => li.id));
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
  } catch {
    log(`No se envió "${texto}": sigue en la caja (¿modo lento o sin permiso?). Reintento en ${REINTENTO} s.`);
    return { estado: 'no-enviado' };
  }

  const respuesta = await leerRespuesta(page, texto, antes);
  if (!respuesta) {
    log(`Enviado: ${texto} (${BOT} no contestó)`);
    return { estado: 'ok' };
  }
  const resumen = respuesta.replace(/\s+/g, ' ').slice(0, 160);
  if (VERIFICACION.test(respuesta)) {
    alerta(`${BOT} pide verificar que sos humano: "${resumen}". Resolvelo en Discord; pauso todo ${PAUSA_PROBLEMA} min.`);
    return { estado: 'verificacion' };
  }
  const cuando = cuandoVuelve(respuesta);
  if (cuando && ESPERA.test(respuesta)) {
    log(`${BOT} pide esperar para "${texto}": vuelvo a probar a las ${hora(cuando.getTime() + MARGEN * 1000)}.`);
    return { estado: 'espera', cuando };
  }
  if (PROBLEMA.test(respuesta)) {
    if (esBuff) log(`No te quedan para "${texto}" ("${resumen}"): sigo normal y pruebo de nuevo en ${REINTENTO_BUFF} min.`);
    else alerta(`${BOT} dice que falta algo para "${texto}": "${resumen}". Pauso ese comando ${PAUSA_PROBLEMA} min.`);
    return { estado: 'problema', respuesta };
  }
  log(`Enviado: ${texto}`);
  return { estado: 'ok', respuesta };
}

async function main() {
  console.log('Mensajes automáticos en Discord');
  for (const m of MENSAJES) console.log(`  ${m.texto.padEnd(20)} cada ${m.cadaMinutos} min`);
  for (const b of BUFFS) console.log(`  ${b.comando.padEnd(20)} buff de ${b.minutos} min, mientras tengas`);
  console.log(`Canal: ${CANAL}\n`);

  mantenerDespierta();
  log('Abriendo Discord...');
  await conectar();
  log(oculto
    ? 'Listo. Discord queda abierto sin ventana: no hace falta tener nada a la vista.'
    : 'Listo. Podés minimizar la ventana de Discord, pero no la cierres.');
  await revisarHaste();

  const inicio = performance.now();
  const ahora = () => (performance.now() - inicio) / 1000;
  const tareas = [
    // Los buffs van primero, así el comando que viene ya lo aprovecha.
    ...BUFFS.map((b, i) => ({ texto: b.comando, buff: b, cada: b.minutos * 60, proximo: 0, orden: i - BUFFS.length })),
    ...MENSAJES.map((m, orden) => ({ ...m, cada: m.cadaMinutos * 60, proximo: m.primeraVez, orden })),
  ];
  let ultimoEnvio = -Infinity;
  // Espera de un comando después de salir bien (la mitad con Haste).
  const esperaDe = (t) => t.cada * (t.haste && Date.now() < hasteHasta ? HASTE_FACTOR : 1) + MARGEN;
  // Cuando empieza un Haste, adelanta mine y fish.
  const adelantar = () => {
    for (const x of tareas) {
      if (x.haste && !x.buff && x.ultimoOk !== undefined) x.proximo = Math.min(x.proximo, x.ultimoOk + esperaDe(x));
    }
  };

  for (;;) {
    // Mientras dura un Haste, no se usa otro.
    for (const x of tareas) {
      if (x.buff?.haste) x.proximo = Math.max(x.proximo, ahora() + (hasteHasta - Date.now()) / 1000 + 2);
    }

    // El que toca primero (si empatan, el que está antes en la lista).
    const t = tareas.reduce((a, b) => (b.proximo < a.proximo ? b : a));
    const cuando = Math.max(t.proximo, ultimoEnvio + SEPARACION_MINIMA);
    let falta = cuando - ahora();
    if (falta > 1) log(`Próximo: "${t.texto}" a las ${hora(Date.now() + falta * 1000)}`);

    // Mientras espera, revisa el canal por si usaste un Haste; si empezó uno, adelanta lo que toca.
    let haste = false;
    while ((falta = cuando - ahora()) > 0 && !haste) {
      await sleep(Math.min(falta, REVISAR) * 1000);
      haste = await revisarHaste().catch(() => false);
    }
    if (haste) {
      adelantar();
      continue;
    }

    let r = { estado: 'no-enviado' };
    try {
      r = await enviar(t.texto, Boolean(t.buff));
    } catch (e) {
      if (!(e instanceof SinSesion)) {
        log(`Error al enviar "${t.texto}": ${e.message.split('\n')[0]}. Reintento en ${REINTENTO} s.`);
      } else {
        log('Discord cerró la sesión: abro la ventana para que vuelvas a iniciarla.');
        await cerrar();
        await conectar();
      }
    }

    // Cada mensaje vuelve a tocar recién cuando pasa su tiempo completo desde que se mandó,
    // o cuando el bot dijo que se puede.
    ultimoEnvio = ahora();
    if (t.buff && r.estado === 'ok') {
      if (!t.buff.haste) {
        t.proximo = ultimoEnvio + t.cada + 2;
      } else if (/haste/i.test(r.respuesta ?? '')) {
        anotarHaste();
        adelantar();
        t.proximo = ultimoEnvio + t.cada + 2;
      } else {
        log(`${BOT} no confirmó el Haste ("${t.texto}"): sigo normal y pruebo de nuevo en ${REINTENTO_BUFF} min.`);
        t.proximo = ultimoEnvio + REINTENTO_BUFF * 60;
      }
    } else if (t.buff && r.estado === 'problema') {
      t.proximo = ultimoEnvio + REINTENTO_BUFF * 60;
    } else if (r.estado === 'ok') {
      t.ultimoOk = ultimoEnvio;
      t.proximo = ultimoEnvio + esperaDe(t);
    } else if (r.estado === 'espera') {
      t.proximo = ultimoEnvio + Math.max(REINTENTO, (r.cuando - Date.now()) / 1000 + MARGEN);
    } else if (r.estado === 'problema') {
      t.proximo = ultimoEnvio + PAUSA_PROBLEMA * 60;
    } else if (r.estado === 'verificacion') {
      for (const x of tareas) x.proximo = Math.max(x.proximo, ultimoEnvio + PAUSA_PROBLEMA * 60);
    } else {
      t.proximo = ultimoEnvio + Math.min(REINTENTO, t.cada);
    }
  }
}

main().catch((e) => {
  console.error(`\n[ERROR] ${e.message}`);
  process.exit(1);
});
