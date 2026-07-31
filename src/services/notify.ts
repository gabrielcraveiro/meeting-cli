import { spawn } from 'child_process';
import { readBridge } from './bridge';

// Native Windows toast notifications from WSL2 via powershell.exe interop.
// Uses the built-in Windows.UI.Notifications API (Windows PowerShell 5.1) —
// no BurntToast or any module required. The command is passed base64-encoded
// (-EncodedCommand) to sidestep quoting across the WSL→Windows boundary.
//
// Suppression: nothing pops while the user is screen-sharing (flag set by the
// browser extension via the daemon). Windows' own presentation Focus Assist
// is a second layer, but we don't rely on it.

export function isScreenSharing(): boolean {
  return readBridge()?.sharing === true;
}

export function notifyWindows(title: string, message: string): void {
  if (isScreenSharing()) return;

  const ps = `
[Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType = WindowsRuntime] | Out-Null
$xml = [Windows.UI.Notifications.ToastNotificationManager]::GetTemplateContent([Windows.UI.Notifications.ToastTemplateType]::ToastText02)
$texts = $xml.GetElementsByTagName('text')
$texts.Item(0).AppendChild($xml.CreateTextNode('${escapePs(title)}')) | Out-Null
$texts.Item(1).AppendChild($xml.CreateTextNode('${escapePs(message)}')) | Out-Null
$toast = [Windows.UI.Notifications.ToastNotification]::new($xml)
[Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier('Meeting CLI').Show($toast)
`.trim();

  const encoded = Buffer.from(ps, 'utf16le').toString('base64');
  try {
    const proc = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand', encoded], {
      stdio: 'ignore',
      detached: true,
    });
    proc.unref();
    proc.on('error', () => {});  // notifications are best-effort, never break the flow
  } catch {}
}

function escapePs(s: string): string {
  return s.replace(/'/g, "''").slice(0, 200);
}
