/** Measures the standalone web view against the device screen so safe-area padding is not applied twice. */
import { useEffect, useState } from 'react';

/** Device and web-view geometry in CSS pixels, read once per resize. */
export type ViewportFacts = {
  screenWidth: number; screenHeight: number; innerWidth: number; innerHeight: number;
  insetTop: number; insetBottom: number; bottomGap: number; standalone: boolean; bottomPadding: number;
};

/** Reads one `env(safe-area-inset-*)` value through a hidden probe element. */
function inset(side: 'top' | 'bottom'): number {
  const probe = document.createElement('div');
  probe.style.cssText = `position:fixed;visibility:hidden;pointer-events:none;padding-${side}:env(safe-area-inset-${side},0px)`;
  document.body.appendChild(probe);
  const value = parseFloat(getComputedStyle(probe)[side === 'top' ? 'paddingTop' : 'paddingBottom']) || 0;
  probe.remove();
  return value;
}

/**
 * In an iOS standalone web app the system can stop the web view above the home-indicator
 * strip while still reporting the full bottom inset. The part of that inset already outside
 * the web view is subtracted, so content ends just above the visible edge.
 */
export function measureViewport(): ViewportFacts {
  const standalone = matchMedia('(display-mode: standalone)').matches || (navigator as { standalone?: boolean }).standalone === true;
  const landscape = innerWidth > innerHeight;
  const long = Math.max(screen.width, screen.height), short = Math.min(screen.width, screen.height);
  const screenHeight = landscape ? short : long, screenWidth = landscape ? long : short;
  const insetTop = inset('top'), insetBottom = inset('bottom');
  // The root is pinned to 100vh in standalone mode, so its height is the painted area even when innerHeight is short.
  const rootHeight = document.getElementById('root')?.getBoundingClientRect().height || innerHeight;
  const bottomGap = standalone ? Math.max(0, Math.round(screenHeight - rootHeight)) : 0;
  const bottomPadding = Math.max(0, insetBottom - bottomGap);
  return { screenWidth, screenHeight, innerWidth, innerHeight, insetTop, insetBottom, bottomGap, standalone, bottomPadding };
}

/** Keeps `--web-safe-bottom` on the root element in sync with the measured web view. */
export function useViewportInsets(): ViewportFacts | null {
  const [facts, setFacts] = useState<ViewportFacts | null>(null);
  useEffect(() => {
    const update = () => {
      const next = measureViewport();
      document.documentElement.style.setProperty('--web-safe-bottom', next.bottomPadding + 'px');
      setFacts(next);
    };
    update();
    addEventListener('resize', update);
    addEventListener('orientationchange', update);
    return () => { removeEventListener('resize', update); removeEventListener('orientationchange', update); };
  }, []);
  return facts;
}
