# Mensajes automaticos en Discord, desde tu propia cuenta (lo usa auto-mensajes.bat).
#
#   - "xmine 2"        cada 2 minutos
#   - "xfish 2"        5 segundos despues de cada xmine
#   - "xpet explore 2" cada 45 minutos (la primera vez, despues del xfish)
#
# Como funciona: trae la ventana de Discord al frente, escribe el mensaje como si
# fuera el teclado, aprieta Enter y te devuelve a la ventana que estabas usando.
# No usa token: es como si lo escribieras vos, asi que el mensaje va al canal que
# este abierto en Discord (la app de escritorio, o la pestana activa del navegador).
#
# Para detenerlo, cerra la ventana.

# ======================= CONFIGURACION =======================
# Texto:       lo que se escribe.
# CadaMinutos: cada cuanto se repite.
# PrimeraVez:  a los cuantos segundos de arrancar se manda la primera vez.
$Mensajes = @(
    @{ Texto = 'xmine 2';        CadaMinutos = 2;  PrimeraVez = 0  }
    @{ Texto = 'xfish 2';        CadaMinutos = 2;  PrimeraVez = 5  }
    @{ Texto = 'xpet explore 2'; CadaMinutos = 45; PrimeraVez = 10 }
)

# Nunca se mandan dos mensajes con menos de estos segundos de diferencia.
$SeparacionMinima = 5

# Despues de enviar, volver a la ventana que estabas usando ($false para quedarse en Discord).
$DevolverFoco = $true
# =============================================================

Add-Type -AssemblyName System.Windows.Forms
if (-not ('AutoMensajes.Ventanas' -as [type])) {
    Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;

namespace AutoMensajes {
    public static class Ventanas {
        [StructLayout(LayoutKind.Sequential)]
        private struct LASTINPUTINFO { public uint cbSize; public uint dwTime; }

        [DllImport("user32.dll")] private static extern bool GetLastInputInfo(ref LASTINPUTINFO plii);
        [DllImport("user32.dll")] private static extern bool SetForegroundWindow(IntPtr hWnd);
        [DllImport("user32.dll")] private static extern void keybd_event(byte bVk, byte bScan, uint dwFlags, UIntPtr dwExtraInfo);
        [DllImport("kernel32.dll")] private static extern uint SetThreadExecutionState(uint esFlags);
        [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
        [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr hWnd, int nCmdShow);
        [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr hWnd);
        [DllImport("user32.dll")] public static extern bool IsWindow(IntPtr hWnd);
        [DllImport("kernel32.dll")] public static extern IntPtr GetConsoleWindow();

        // Milisegundos desde la ultima vez que se toco el teclado o el mouse.
        public static uint Inactivo() {
            LASTINPUTINFO info = new LASTINPUTINFO();
            info.cbSize = (uint)Marshal.SizeOf(typeof(LASTINPUTINFO));
            if (!GetLastInputInfo(ref info)) return uint.MaxValue;
            return unchecked((uint)Environment.TickCount - info.dwTime);
        }

        // Trae una ventana al frente. Windows no deja que cualquier programa le saque
        // el foco a otro, pero si lo permite mientras Alt esta apretado (como Alt+Tab).
        public static bool Enfocar(IntPtr hWnd) {
            if (hWnd == IntPtr.Zero || !IsWindow(hWnd)) return false;
            if (IsIconic(hWnd)) ShowWindow(hWnd, 9); // SW_RESTORE
            if (GetForegroundWindow() == hWnd) return true;
            keybd_event(0x12, 0, 0, UIntPtr.Zero); // Alt abajo
            SetForegroundWindow(hWnd);
            keybd_event(0x12, 0, 2, UIntPtr.Zero); // Alt arriba
            return GetForegroundWindow() == hWnd;
        }

        // Mientras el script corre, la PC no se suspende ni apaga la pantalla.
        public static void NoSuspender() {
            SetThreadExecutionState(0x80000003); // ES_CONTINUOUS | ES_SYSTEM_REQUIRED | ES_DISPLAY_REQUIRED
        }
    }
}
'@
}

$Navegadores = 'chrome', 'msedge', 'firefox', 'opera', 'brave', 'vivaldi'

function Escribir-Log([string]$Texto, [ConsoleColor]$Color = 'Gray') {
    Write-Host ('[{0:HH:mm:ss}] {1}' -f (Get-Date), $Texto) -ForegroundColor $Color
}

# SendKeys usa + ^ % ~ ( ) { } [ ] como teclas especiales: van entre llaves.
function Escapar([string]$Texto) {
    [regex]::Replace($Texto, '[+^%~(){}\[\]]', '{$0}')
}

function Buscar-Discord {
    $consola = [AutoMensajes.Ventanas]::GetConsoleWindow()
    $ventanas = @(Get-Process -ErrorAction SilentlyContinue |
        Where-Object { $_.MainWindowHandle -ne [IntPtr]::Zero -and $_.MainWindowHandle -ne $consola })
    # La app de escritorio (Discord, DiscordPTB o DiscordCanary).
    $app = $ventanas | Where-Object { $_.ProcessName -like 'Discord*' } | Select-Object -First 1
    if ($app) { return $app.MainWindowHandle }
    # Discord en el navegador: tiene que ser la pestana activa.
    $web = $ventanas | Where-Object { $Navegadores -contains $_.ProcessName -and $_.MainWindowTitle -like '*Discord*' } |
        Select-Object -First 1
    if ($web) { return $web.MainWindowHandle }
    return [IntPtr]::Zero
}

# Si estas usando la PC, espera a que sueltes teclado y mouse 1 segundo (como mucho 10)
# para que lo que estes escribiendo no se mezcle con el mensaje.
function Esperar-Inactividad {
    $limite = [Diagnostics.Stopwatch]::StartNew()
    while ([AutoMensajes.Ventanas]::Inactivo() -lt 1000 -and $limite.Elapsed.TotalSeconds -lt 10) {
        Start-Sleep -Milliseconds 200
    }
}

function Enviar-Mensaje([string]$Texto) {
    $discord = Buscar-Discord
    if ($discord -eq [IntPtr]::Zero) {
        Escribir-Log "No encontre Discord abierto: no envie '$Texto'. Abrilo (que no quede solo en la bandeja)." Yellow
        return
    }

    Esperar-Inactividad
    $anterior = [AutoMensajes.Ventanas]::GetForegroundWindow()
    $minimizado = [AutoMensajes.Ventanas]::IsIconic($discord)

    $enfocado = $false
    for ($intento = 1; $intento -le 3 -and -not $enfocado; $intento++) {
        $enfocado = [AutoMensajes.Ventanas]::Enfocar($discord)
        if (-not $enfocado) { Start-Sleep -Milliseconds 300 }
    }

    if (-not $enfocado) {
        Escribir-Log "No pude traer Discord al frente (la PC esta bloqueada?): no envie '$Texto'." Yellow
    } else {
        # Darle tiempo a Discord a dibujarse antes de escribir.
        Start-Sleep -Milliseconds $(if ($minimizado) { 1000 } else { 300 })
        [System.Windows.Forms.SendKeys]::SendWait((Escapar $Texto))
        Start-Sleep -Milliseconds 150
        # Si justo cambiaste de ventana, no apretar Enter en otro lado.
        if ([AutoMensajes.Ventanas]::GetForegroundWindow() -eq $discord) {
            [System.Windows.Forms.SendKeys]::SendWait('{ENTER}')
            Escribir-Log "Enviado: $Texto" Green
        } else {
            Escribir-Log "Cambiaste de ventana mientras escribia: no envie '$Texto'." Yellow
        }
    }

    if ($DevolverFoco -and $anterior -ne $discord) {
        Start-Sleep -Milliseconds 200
        if ($minimizado) { [void][AutoMensajes.Ventanas]::ShowWindow($discord, 7) } # SW_SHOWMINNOACTIVE
        [void][AutoMensajes.Ventanas]::Enfocar($anterior)
    }
}

# ---------- Inicio ----------
$Host.UI.RawUI.WindowTitle = 'Auto mensajes'
[AutoMensajes.Ventanas]::NoSuspender()

$reloj = [Diagnostics.Stopwatch]::StartNew()
function Ahora { $reloj.Elapsed.TotalSeconds }

$orden = 0
$tareas = @(foreach ($m in $Mensajes) {
    [pscustomobject]@{
        Texto   = [string]$m.Texto
        Cada    = [double]$m.CadaMinutos * 60
        Proximo = [double]$m.PrimeraVez
        Orden   = $orden++
    }
})

Write-Host 'Mensajes automaticos en Discord' -ForegroundColor Cyan
foreach ($t in $tareas) {
    Write-Host ('  {0,-20} cada {1} min' -f $t.Texto, ($t.Cada / 60))
}
Write-Host ''
Write-Host 'Deja abierto en Discord el canal donde se tienen que escribir.'
Write-Host 'La PC tiene que quedar desbloqueada. Para detenerlo, cerra esta ventana.'
Write-Host ''

$ultimoEnvio = [double]::NegativeInfinity
while ($true) {
    # El que toca primero (si empatan, el que esta antes en la lista).
    $t = $tareas | Sort-Object Proximo, Orden | Select-Object -First 1
    $cuando = [Math]::Max($t.Proximo, $ultimoEnvio + $SeparacionMinima)

    $falta = $cuando - (Ahora)
    if ($falta -gt 1) {
        Escribir-Log ("Proximo: '{0}' a las {1:HH:mm:ss}" -f $t.Texto, (Get-Date).AddSeconds($falta)) DarkGray
    }
    while (($falta = $cuando - (Ahora)) -gt 0) {
        Start-Sleep -Milliseconds ([Math]::Max(1, [Math]::Min(500, [int]($falta * 1000))))
    }

    try {
        Enviar-Mensaje $t.Texto
    } catch {
        Escribir-Log "Error al enviar '$($t.Texto)': $($_.Exception.Message)" Red
    }

    # Cada mensaje vuelve a tocar recien cuando pasa su tiempo completo desde que se mando.
    $ultimoEnvio = Ahora
    $t.Proximo = $ultimoEnvio + $t.Cada
}
