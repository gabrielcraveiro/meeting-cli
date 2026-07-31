# Meeting CLI — Tray companion (Windows)
# Ícone na bandeja que acompanha o daemon (http://127.0.0.1:7899):
#   cinza  = daemon ocioso, aguardando call
#   verde  = gravando
#   escuro = daemon offline
# Menu: parar gravação, abrir vault, sair.
#
# Instalação (autostart): Win+R → shell:startup → criar atalho para:
#   powershell.exe -WindowStyle Hidden -ExecutionPolicy Bypass -File "C:\Documentos\meeting-cli\scripts\meeting-tray.ps1"

Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing

$daemonUrl = 'http://127.0.0.1:7899'
$vaultPath = 'C:\Documentos\Obsidian\epharma-labs'

function New-DotIcon([System.Drawing.Color]$color) {
    $bmp = New-Object System.Drawing.Bitmap(16, 16)
    $g = [System.Drawing.Graphics]::FromImage($bmp)
    $g.SmoothingMode = 'AntiAlias'
    $brush = New-Object System.Drawing.SolidBrush($color)
    $g.FillEllipse($brush, 2, 2, 12, 12)
    $g.Dispose()
    return [System.Drawing.Icon]::FromHandle($bmp.GetHicon())
}

$iconIdle      = New-DotIcon ([System.Drawing.Color]::FromArgb(158, 158, 158))  # cinza
$iconRecording = New-DotIcon ([System.Drawing.Color]::FromArgb(76, 175, 80))    # verde discreto
$iconOffline   = New-DotIcon ([System.Drawing.Color]::FromArgb(66, 66, 66))     # quase invisível

$tray = New-Object System.Windows.Forms.NotifyIcon
$tray.Icon = $iconOffline
$tray.Text = 'Meeting CLI — daemon offline'
$tray.Visible = $true

$menu = New-Object System.Windows.Forms.ContextMenuStrip
$statusItem = $menu.Items.Add('daemon offline'); $statusItem.Enabled = $false
$menu.Items.Add('-') | Out-Null
$stopItem = $menu.Items.Add('Parar gravação')
$stopItem.Add_Click({
    try { Invoke-RestMethod -Method Post -Uri "$daemonUrl/stop" -TimeoutSec 3 | Out-Null } catch {}
})
$vaultItem = $menu.Items.Add('Abrir vault (Meetings)')
$vaultItem.Add_Click({ Start-Process explorer.exe (Join-Path $vaultPath 'Meetings') })
$menu.Items.Add('-') | Out-Null
$exitItem = $menu.Items.Add('Sair do tray')
$exitItem.Add_Click({ $tray.Visible = $false; [System.Windows.Forms.Application]::Exit() })
$tray.ContextMenuStrip = $menu

$timer = New-Object System.Windows.Forms.Timer
$timer.Interval = 5000
$timer.Add_Tick({
    try {
        $st = Invoke-RestMethod -Uri "$daemonUrl/status" -TimeoutSec 2
        if ($st.recording) {
            $tray.Icon = $iconRecording
            $tray.Text = 'Meeting CLI — gravando'
            $statusItem.Text = '● Gravando'
            $stopItem.Enabled = $true
        } else {
            $tray.Icon = $iconIdle
            $tray.Text = 'Meeting CLI — aguardando call'
            $statusItem.Text = 'Ocioso — aguardando call'
            $stopItem.Enabled = $false
        }
    } catch {
        $tray.Icon = $iconOffline
        $tray.Text = 'Meeting CLI — daemon offline'
        $statusItem.Text = 'daemon offline (rode: meeting daemon)'
        $stopItem.Enabled = $false
    }
})
$timer.Start()

[System.Windows.Forms.Application]::Run()
