import { useEffect, useRef } from 'react';

export function usePolling(callback: () => Promise<void> | void, intervalMs: number = 15000) {
  const savedCallback = useRef(callback);

  useEffect(() => {
    savedCallback.current = callback;
  }, [callback]);

  useEffect(() => {
    let isMounted = true;

    const tick = async () => {
      if (isMounted) {
        await savedCallback.current();
      }
    };

    tick();
    const id = setInterval(tick, intervalMs);
    return () => {
      isMounted = false;
      clearInterval(id);
    };
  }, [intervalMs]);
}
