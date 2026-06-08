import { useEffect } from 'react';
import type { RefObject } from 'react';

export function useHideFlexLayoutArtifacts(containerRef: RefObject<HTMLElement | null>): void {
  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    const hideArtifacts = () => {
      container
        .querySelectorAll('.flexlayout__layout_metrics, .flexlayout__layout_tab_stamps')
        .forEach((element) => {
          element.setAttribute('aria-hidden', 'true');
        });
    };

    hideArtifacts();
    const frame = window.requestAnimationFrame(hideArtifacts);
    return () => window.cancelAnimationFrame(frame);
  }, [containerRef]);
}
