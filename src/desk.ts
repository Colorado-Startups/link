// SPDX-License-Identifier: Apache-2.0
// The desk: the two things Link does on the Mac itself for a reply the member sends by hand. It puts text on the
// clipboard with /usr/bin/pbcopy and opens a www.linkedin.com page with /usr/bin/open. Nothing here sends anything:
// the member reads the reply, presses Cmd+V and then Enter. Tests pass a fake desk.
import { spawn } from 'node:child_process';
import { childEnv, LinkError } from './core.ts';

export interface Desk {
  copy: (text: string) => Promise<void>;
  open: (url: string) => Promise<void>;
}

/** The real desk. pbcopy reads UTF-8 only when told so, hence LANG; every other variable is childEnv's. */
export function macDesk(env: Record<string, string | undefined>): Desk {
  const run = (cmd: string, args: string[], input = '') =>
    new Promise<void>((done, fail) => {
      const child = spawn(cmd, args, { stdio: ['pipe', 'ignore', 'ignore'], env: { ...childEnv(env), LANG: 'en_US.UTF-8' } });
      child.on('error', () => fail(new LinkError(`Could not start ${cmd}.`)));
      child.on('close', (code) => (code === 0 ? done() : fail(new LinkError(`${cmd} failed (exit ${code}).`))));
      child.stdin.on('error', () => {});
      child.stdin.end(input);
    });
  return {
    copy: (text) => run('/usr/bin/pbcopy', [], text),
    open: (url) => {
      if (!url.startsWith('https://www.linkedin.com/')) return Promise.reject(new LinkError('Link opens www.linkedin.com pages only.'));
      return run('/usr/bin/open', [url]);
    },
  };
}
