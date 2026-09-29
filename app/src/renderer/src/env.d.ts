/// <reference types="vite/client" />
import type { MeadowBridge } from '../../preload/index.ts';

declare global {
  interface Window {
    meadow: MeadowBridge;
  }
}
