import { spawn } from 'node:child_process';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { prepareUpdateInstall } from './githubUpdater';

const tempDirs: string[] = [];

function run(command: string, args: string[], cwd?: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd, stdio: 'ignore', windowsHide: true });
    child.on('error', reject);
    child.on('close', (code) =>
      code === 0 ? resolve() : reject(new Error(`${command} exited with ${code}`))
    );
  });
}

async function makeTempDir(prefix: string): Promise<string> {
  const dir = await fs.mkdtemp(path.join(await fs.realpath(os.tmpdir()), prefix));
  tempDirs.push(dir);
  return dir;
}

async function writeLauncher(dir: string, markerPath: string): Promise<string> {
  if (process.platform === 'win32') {
    const launcher = path.join(dir, 'Goose.cmd');
    await fs.writeFile(launcher, `@echo off\r\necho relaunched> "${markerPath}"\r\n`);
    return launcher;
  }

  const launcher = path.join(dir, 'Goose');
  await fs.writeFile(launcher, `#!/bin/sh\necho relaunched > "${markerPath}"\n`, { mode: 0o755 });
  return launcher;
}

async function makePayload(root: string, version: string, markerPath: string): Promise<string> {
  if (process.platform === 'darwin') {
    const bundle = path.join(root, 'Goose.app');
    const macOsDir = path.join(bundle, 'Contents', 'MacOS');
    await fs.mkdir(macOsDir, { recursive: true });
    await fs.writeFile(
      path.join(bundle, 'Contents', 'Info.plist'),
      `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>CFBundleExecutable</key><string>Goose</string>
<key>CFBundleIdentifier</key><string>dev.goose.updater.test.${version}</string>
<key>CFBundlePackageType</key><string>APPL</string>
</dict></plist>
`
    );
    await writeLauncher(macOsDir, markerPath);
    await fs.writeFile(path.join(bundle, 'version.txt'), version);
    return bundle;
  }

  const payload = path.join(root, 'Goose');
  await fs.mkdir(payload, { recursive: true });
  await writeLauncher(payload, markerPath);
  await fs.writeFile(path.join(payload, 'version.txt'), version);
  return payload;
}

async function zip(payloadPath: string, archivePath: string): Promise<void> {
  const parent = path.dirname(payloadPath);
  const name = path.basename(payloadPath);

  if (process.platform === 'darwin') {
    await run('ditto', ['-c', '-k', '--sequesterRsrc', '--keepParent', name, archivePath], parent);
  } else if (process.platform === 'win32') {
    await run(
      'powershell.exe',
      [
        '-NoProfile',
        '-NonInteractive',
        '-Command',
        `Compress-Archive -Path '${payloadPath}' -DestinationPath '${archivePath}' -Force`,
      ],
      parent
    );
  } else {
    await run('zip', ['-r', '-q', archivePath, name], parent);
  }
}

async function waitFor(check: () => Promise<boolean>, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await check()) {
      return true;
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  return false;
}

async function exists(target: string): Promise<boolean> {
  try {
    await fs.access(target);
    return true;
  } catch {
    return false;
  }
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

describe('prepareUpdateInstall', () => {
  it('waits for the app to exit, swaps in the new version, and relaunches it', async () => {
    const workspace = await makeTempDir('goose-update-test-');
    const stagingDir = path.join(workspace, 'staging');
    const payloadSource = path.join(workspace, 'payload');
    const installRoot = path.join(workspace, 'install');
    const markerPath = path.join(workspace, 'relaunched.txt');
    await fs.mkdir(stagingDir, { recursive: true });
    await fs.mkdir(payloadSource, { recursive: true });
    await fs.mkdir(installRoot, { recursive: true });

    const newPayload = await makePayload(payloadSource, '2.0.0', markerPath);
    const archivePath = path.join(stagingDir, 'Goose-2.0.0.zip');
    await zip(newPayload, archivePath);

    const installedRoot = await makePayload(installRoot, '1.0.0', markerPath);
    const versionFile = path.join(installedRoot, 'version.txt');

    const relaunchPath =
      process.platform === 'darwin'
        ? installedRoot
        : path.join(installedRoot, process.platform === 'win32' ? 'Goose.cmd' : 'Goose');

    const runningApp = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 120000)'], {
      stdio: 'ignore',
      windowsHide: true,
    });
    await new Promise((resolve) => setTimeout(resolve, 500));

    const swap = await prepareUpdateInstall({
      archivePath,
      targetPath: installedRoot,
      relaunchPath,
      pid: runningApp.pid!,
    });

    const swapProcess = spawn(swap.command, swap.args, {
      detached: true,
      stdio: 'ignore',
      windowsHide: true,
    });
    swapProcess.unref();

    await new Promise((resolve) => setTimeout(resolve, 2000));
    expect(await fs.readFile(versionFile, 'utf8')).toBe('1.0.0');
    expect(await exists(markerPath)).toBe(false);

    runningApp.kill();
    await new Promise((resolve) => runningApp.once('exit', resolve));

    expect(
      await waitFor(
        async () => (await fs.readFile(versionFile, 'utf8').catch(() => '')) === '2.0.0',
        60000
      )
    ).toBe(true);
    expect(await waitFor(() => exists(markerPath), 60000)).toBe(true);
    expect(await waitFor(async () => !(await exists(stagingDir)), 60000)).toBe(true);
  }, 150000);
});
