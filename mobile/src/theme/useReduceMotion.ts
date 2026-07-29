import { useEffect, useState } from 'react';
import { isReduceMotionEnabled, onReduceMotionChange } from '../tokens/motion';

/** Hook that tracks the system reduce-motion accessibility preference */
export function useReduceMotion(): boolean {
  const [reduceMotion, setReduceMotion] = useState(false);

  useEffect(() => {
    isReduceMotionEnabled().then(setReduceMotion);
    const unsubscribe = onReduceMotionChange(setReduceMotion);
    return unsubscribe;
  }, []);

  return reduceMotion;
}
