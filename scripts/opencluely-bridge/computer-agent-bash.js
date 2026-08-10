/**
 * Bash executor with safety blocklist — ported from suitedaces/computer-agent (Apache-2.0).
 */
const { execFile } = require('child_process');
const { promisify } = require('util');

const execFileAsync = promisify(execFile);

const BLOCKED_PATTERNS = [
  'rm -rf /',
  'rm -rf /*',
  'rm -rf ~',
  'rm -rf $HOME',
  ':(){:|:&};:',
  'mkfs',
  'dd if=',
  '> /dev/sd',
  'chmod -R 777 /',
  'sudo rm',
  'sudo mkfs',
  'sudo dd',
  'nc -l',
  'nmap',
  'csrutil disable',
];

class BashExecutor {
  constructor() {
    this.cwd = process.env.HOME || process.cwd();
  }

  restart() {
    this.cwd = process.env.HOME || process.cwd();
    return { ok: true };
  }

  isBlocked(command) {
    const lower = String(command || '').toLowerCase();
    for (const pattern of BLOCKED_PATTERNS) {
      if (lower.includes(pattern.toLowerCase())) {
        return `Command contains blocked pattern: ${pattern}`;
      }
    }
    if (/curl.*\|.*sh/i.test(command) || /wget.*\|.*sh/i.test(command)) {
      return 'Piped curl/wget to shell is blocked';
    }
    return null;
  }

  async execute(command) {
    const cmd = String(command || '').trim();
    if (!cmd) return { exitCode: 0, stdout: '', stderr: '' };

    const blocked = this.isBlocked(cmd);
    if (blocked) throw new Error(blocked);

    const shell = process.platform === 'win32' ? 'cmd.exe' : '/bin/bash';
    const args =
      process.platform === 'win32'
        ? ['/d', '/s', '/c', cmd]
        : ['-lc', cmd];

    try {
      const { stdout, stderr } = await execFileAsync(shell, args, {
        cwd: this.cwd,
        timeout: 60_000,
        maxBuffer: 512 * 1024,
        env: { ...process.env, PATH: process.env.PATH },
      });
      return {
        exitCode: 0,
        stdout: String(stdout || ''),
        stderr: String(stderr || ''),
      };
    } catch (error) {
      const stdout = String(error?.stdout || '');
      const stderr = String(error?.stderr || error?.message || '');
      return {
        exitCode: typeof error?.code === 'number' ? error.code : 1,
        stdout,
        stderr,
      };
    }
  }
}

module.exports = { BashExecutor };
