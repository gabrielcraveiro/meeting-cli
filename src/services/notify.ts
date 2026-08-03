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

/**
 * @param launchUrl URI de protocolo (ex: obsidian://open?...) aberta ao CLICAR
 *                  no toast. Sem ela, o clique só dispensa a notificação.
 */
export function notifyWindows(title: string, message: string, launchUrl?: string): void {
  if (isScreenSharing()) return;

  // XML manual (em vez do template) porque activationType="protocol" + launch
  // só existem no elemento <toast> raiz.
  const launchAttr = launchUrl
    ? ` activationType="protocol" launch="${escapeXml(launchUrl)}"`
    : '';
  const toastXml =
    `<toast${launchAttr}><visual><binding template="ToastText02">` +
    `<text id="1">${escapeXml(title)}</text>` +
    `<text id="2">${escapeXml(message)}</text>` +
    `</binding></visual></toast>`;

  const ps = `
[Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType = WindowsRuntime] | Out-Null
[Windows.Data.Xml.Dom.XmlDocument, Windows.Data.Xml.Dom.XmlDocument, ContentType = WindowsRuntime] | Out-Null
$xml = [Windows.Data.Xml.Dom.XmlDocument]::new()
$xml.LoadXml('${escapePs(toastXml)}')
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
  return s.replace(/'/g, "''");
}

function escapeXml(s: string): string {
  return s.slice(0, 400)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&apos;');
}
