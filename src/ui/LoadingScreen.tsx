import { AnimatePresence, motion } from 'framer-motion';

import { GlyphRain } from './GlyphRain';

interface LoadingScreenProps {
  progress: number;
  ready: boolean;
}

export function LoadingScreen({ progress, ready }: LoadingScreenProps) {
  const done = ready && progress >= 0.999;

  return (
    <AnimatePresence>
      {!done && (
        <motion.div
          className="loading"
          initial={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          transition={{ duration: 0.7, ease: [0.32, 0.72, 0, 1] }}
          role="status"
          aria-live="polite"
        >
          <GlyphRain className="loading__rain" />
          <div className="loading__inner">
            <div className="loading__orbit" aria-hidden="true">
              <span className="loading__sun" />
              <span className="loading__planet" />
            </div>
            <p className="loading__chapter">
              A journey through our celestial home
            </p>
            <h1 className="loading__title">Orrery</h1>
            <p className="loading__sub">Rendering the known universe</p>
            <div className="loading__track" aria-hidden="true">
              <motion.div
                className="loading__fill"
                animate={{ width: `${Math.round(progress * 100)}%` }}
                transition={{ ease: 'linear', duration: 0.25 }}
              />
            </div>
            <p className="loading__pct">{Math.round(progress * 100)}%</p>
            <p className="loading__credit">
              <b>Preciado</b> Tech
            </p>
          </div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}
