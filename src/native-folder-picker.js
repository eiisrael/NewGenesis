import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

function pickerError(message, code = 'folder_picker_unavailable', status = 501) {
  return Object.assign(new Error(message), { code, status });
}

export async function pickProjectDirectory({ signal } = {}) {
  if (process.platform === 'win32') {
    const script = [
      'Add-Type -AssemblyName System.Windows.Forms',
      'Add-Type -AssemblyName System.Drawing',
      '[System.Windows.Forms.Application]::EnableVisualStyles()',
      '$owner = New-Object System.Windows.Forms.Form',
      '$owner.Text = "Genesis"',
      '$owner.ShowInTaskbar = $false',
      '$owner.StartPosition = [System.Windows.Forms.FormStartPosition]::CenterScreen',
      '$owner.Size = New-Object System.Drawing.Size(1, 1)',
      '$owner.Opacity = 0',
      '$owner.TopMost = $true',
      '$owner.Show()',
      '$owner.Activate()',
      '$dialog = New-Object System.Windows.Forms.FolderBrowserDialog',
      "$dialog.Description = 'Selecione a pasta que o Genesis poderá analisar e editar'",
      '$dialog.ShowNewFolderButton = $false',
      '$result = $dialog.ShowDialog($owner)',
      '$selectedPath = if ($result -eq [System.Windows.Forms.DialogResult]::OK) { $dialog.SelectedPath } else { $null }',
      '$dialog.Dispose()',
      '$owner.Close()',
      '$owner.Dispose()',
      "if ($selectedPath) { [Console]::OutputEncoding = [System.Text.Encoding]::UTF8; Write-Output $selectedPath }"
    ].join('; ');
    const { stdout } = await execFileAsync('powershell.exe', ['-NoProfile', '-STA', '-Command', script], {
      windowsHide: true,
      timeout: 10 * 60 * 1000,
      maxBuffer: 1024 * 1024,
      encoding: 'utf8',
      signal
    });
    return String(stdout || '').trim() || null;
  }

  if (process.platform === 'darwin') {
    const { stdout } = await execFileAsync('osascript', ['-e', 'POSIX path of (choose folder with prompt "Selecione a pasta do projeto")'], {
      timeout: 10 * 60 * 1000,
      encoding: 'utf8',
      signal
    });
    return String(stdout || '').trim() || null;
  }

  if (process.platform === 'linux') {
    try {
      const { stdout } = await execFileAsync('zenity', ['--file-selection', '--directory', '--title=Selecione a pasta do projeto'], {
        timeout: 10 * 60 * 1000,
        encoding: 'utf8',
        signal
      });
      return String(stdout || '').trim() || null;
    } catch (error) {
      if ([1, 5].includes(error.code)) return null;
      throw pickerError('O seletor nativo de pastas não está disponível. Instale o Zenity ou use a importação em modo leitura.');
    }
  }

  throw pickerError('O seletor nativo de pastas não é compatível com este sistema.');
}
