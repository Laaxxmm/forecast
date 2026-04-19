import type { VcfoBridge } from '../../electron/preload';

declare global {
  interface Window {
    vcfo: VcfoBridge;
  }
}

export {};
