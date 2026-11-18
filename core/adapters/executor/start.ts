const path = require('node:path') as typeof import('node:path');

type Ports = {
  permissions(): Promise<boolean>;
  adminGroup(): Promise<boolean>;
  pfCanary(): Promise<string>;
  run(command: string, args: string[], options: { stdio: 'ignore'; env: Record<string, never> }): Promise<number | null>;
};
type Result = { ok: true; exitCode: number | null } | { ok: false; code: 'boundary-config' | 'boundary-permissions' | 'boundary-admin' | 'boundary-pf' | 'executor-launch' };
export declare const startExecutor: typeof start;
declare const exports: { startExecutor: typeof start };

async function start(ports: Ports, config: { sshConfigPath: string }): Promise<Result> {
  const configPath = config?.sshConfigPath;
  if (typeof configPath !== 'string' || !path.posix.isAbsolute(configPath) || configPath.includes('\0') || path.posix.normalize(configPath) !== configPath || configPath === '/') return { ok: false, code: 'boundary-config' };
  try { if (await ports.permissions() !== true) return { ok: false, code: 'boundary-permissions' }; }
  catch { return { ok: false, code: 'boundary-permissions' }; }
  try { if (await ports.adminGroup() !== true) return { ok: false, code: 'boundary-admin' }; }
  catch { return { ok: false, code: 'boundary-admin' }; }
  try { if (await ports.pfCanary() !== 'refused') return { ok: false, code: 'boundary-pf' }; }
  catch { return { ok: false, code: 'boundary-pf' }; }
  try {
    const exitCode = await ports.run('/usr/bin/ssh', ['-F', configPath, 'executor-core'], { stdio: 'ignore', env: {} });
    if (exitCode !== null && (!Number.isInteger(exitCode) || exitCode < 0 || exitCode > 255)) return { ok: false, code: 'executor-launch' };
    return { ok: true, exitCode };
  } catch { return { ok: false, code: 'executor-launch' }; }
}
exports.startExecutor = start;
