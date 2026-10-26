// A plugin's dry run (SPEC §16.26.7): renders each case with the real components, one at a time, in
// a hidden window with no bridge to the app and no network. Each case announces itself on the
// console first, so the main process knows which one was running if this window stalls or crashes.
import { createRoot } from 'react-dom/client';
import { flushSync } from 'react-dom';
import './styles.css';
import type { EmbedView } from '../../shared/api.ts';
import { Embeds } from './Embeds.tsx';

declare global {
  interface Window {
    __dryrun(cases: { label: string; view: EmbedView }[]): Promise<{ i: number; error: string | null }[]>;
  }
}

window.__dryrun = async (cases) => {
  const out: { i: number; error: string | null }[] = [];
  for (let i = 0; i < cases.length; i++) {
    console.log(`meadow-dryrun:${i}`);
    const el = document.createElement('div');
    document.getElementById('root')!.replaceChildren(el);
    const root = createRoot(el);
    let error: string | null = null;
    try {
      flushSync(() => root.render(<Embeds embeds={[cases[i].view]} onError={(_type, message) => (error = message)} />));
    } catch (e) {
      error = (e as Error)?.message ?? String(e);
    }
    root.unmount();
    out.push({ i, error });
    // Let the main process's watch see each step.
    await new Promise((r) => setTimeout(r, 0));
  }
  console.log('meadow-dryrun:done');
  return out;
};
