/**
 * The interface layer.
 *
 * Every component here renders only on discrete user action. Continuously
 * changing numbers come through `<Live>`, which binds a DOM node to the
 * telemetry channel and is never re-rendered.
 */

import { AnimatePresence, motion } from 'framer-motion';
import { useCallback, useEffect, useState } from 'react';

import { BODIES, BODY_BY_ID, PLANETS } from '../data/bodies';
import { copyFor } from '../data/copy';
import { audio } from '../audio/engine';
import { quality } from '../perf/QualityManager';
import { TIER_ORDER, type TierName } from '../perf/tiers';
import { SPEED_PRESETS, simClock } from '../sim/SimClock';
import { KM_PER_UNIT } from '../sim/constants';
import { useUIStore, type OverlayFlags } from '../state/uiStore';
import { Live } from './Live';
import { JogWheel } from './primitives/JogWheel';
import { useCompactLayout } from './useCompactLayout';

const SPRING = {
  type: 'spring' as const,
  stiffness: 420,
  damping: 34,
  mass: 0.8,
};

export function Hud() {
  const focused = useUIStore((s) => s.focusedBody);
  const accent = BODY_BY_ID[focused]?.accent ?? '#5ce1f2';

  // A single CSS variable drives every accent in the interface, so the whole
  // UI takes on the colour of whatever you're looking at.
  useEffect(() => {
    document.documentElement.style.setProperty('--accent', accent);
  }, [accent]);

  useEffect(() => {
    audio.setBody(focused);
  }, [focused]);

  return (
    <div className="hud">
      <TopBar />
      <BodyRail />
      <Inspector />
      <Timeline />
    </div>
  );
}

// ------------------------------------------------------------------ top bar

function TopBar() {
  const audience = useUIStore((s) => s.audience);
  const setAudience = useUIStore((s) => s.setAudience);
  const panel = useUIStore((s) => s.panel);
  const togglePanel = useUIStore((s) => s.togglePanel);

  return (
    <div className="hud__top pointer-events-auto">
      <div className="brand">
        <span className="brand__mark" aria-hidden="true" />
        <span className="brand__lockup">
          <span className="brand__eyebrow">Deep space atlas · 01</span>
          <span className="brand__name">Orrery</span>
        </span>
      </div>

      <div className="mission-readout" aria-hidden="true">
        <span className="mission-readout__pulse" />
        <span>Live ephemeris</span>
        <span className="mission-readout__divider" />
        <span>Sol system</span>
      </div>

      <div className="segmented" role="radiogroup" aria-label="Reading level">
        {(['explorer', 'scientist'] as const).map((mode) => (
          <button
            key={mode}
            role="radio"
            aria-checked={audience === mode}
            className={`segmented__item${audience === mode ? ' is-active' : ''}`}
            onClick={() => {
              setAudience(mode);
              audio.select();
            }}
          >
            {mode === 'explorer' ? 'Explorer' : 'Scientist'}
          </button>
        ))}
      </div>

      <div className="hud__top-actions">
        <IconButton
          label="Data layers"
          active={panel === 'layers'}
          onClick={() => togglePanel('layers')}
        >
          <svg viewBox="0 0 24 24" width="17" height="17" aria-hidden="true">
            <path
              d="M12 3 3 8l9 5 9-5-9-5Z"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.6"
              strokeLinejoin="round"
            />
            <path
              d="m3 13 9 5 9-5"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.6"
              strokeLinejoin="round"
            />
          </svg>
        </IconButton>
        <IconButton
          label="Settings"
          active={panel === 'settings'}
          onClick={() => togglePanel('settings')}
        >
          <svg viewBox="0 0 24 24" width="17" height="17" aria-hidden="true">
            <circle
              cx="12"
              cy="12"
              r="3.2"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.6"
            />
            <path
              d="M12 2v3m0 14v3M2 12h3m14 0h3M4.9 4.9 7 7m10 10 2.1 2.1M19.1 4.9 17 7M7 17l-2.1 2.1"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.6"
              strokeLinecap="round"
            />
          </svg>
        </IconButton>
      </div>

      <AnimatePresence>
        {panel === 'layers' && <LayersPanel key="layers" />}
        {panel === 'settings' && <SettingsPanel key="settings" />}
      </AnimatePresence>
    </div>
  );
}

function IconButton({
  label,
  active,
  onClick,
  children,
}: {
  label: string;
  active?: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      className={`icon-button${active ? ' is-active' : ''}`}
      onClick={onClick}
      aria-label={label}
      aria-pressed={active}
      title={label}
    >
      {children}
    </button>
  );
}

// --------------------------------------------------------------- body rail

function BodyRail() {
  const focused = useUIStore((s) => s.focusedBody);
  const setFocused = useUIStore((s) => s.setFocused);
  const visited = useUIStore((s) => s.visited);

  const select = useCallback(
    (id: string) => {
      setFocused(id);
      audio.whoosh();
    },
    [setFocused]
  );

  const entries = [BODY_BY_ID.sun, ...PLANETS, BODY_BY_ID.pluto];

  return (
    <nav className="body-rail pointer-events-auto" aria-label="Choose a world">
      {entries.map((body) => {
        const isFocused = focused === body.id;
        const seen = visited.includes(body.id);
        return (
          <button
            key={body.id}
            className={`body-chip${isFocused ? ' is-active' : ''}`}
            style={{ '--chip': body.accent } as React.CSSProperties}
            onClick={() => select(body.id)}
            aria-current={isFocused}
            title={body.name}
          >
            <span className="body-chip__dot" aria-hidden="true" />
            <span className="body-chip__name">{body.name}</span>
            {seen && <span className="body-chip__seen" aria-label="Visited" />}
          </button>
        );
      })}
    </nav>
  );
}

// ---------------------------------------------------------------- inspector

function Inspector() {
  const focused = useUIStore((s) => s.focusedBody);
  const audience = useUIStore((s) => s.audience);
  // Collapsed by default on a phone. Expanded, the panel plus the rail and
  // timeline leave almost no room for the thing being described.
  const compact = useCompactLayout();
  const [expanded, setExpanded] = useState(!compact);

  const body = BODY_BY_ID[focused];
  if (!body) return null;
  const copy = copyFor(focused);

  const num = (v: number, digits = 0) =>
    v.toLocaleString(undefined, { maximumFractionDigits: digits });

  const stats: Array<{ label: string; value: string; hint?: string }> =
    audience === 'scientist'
      ? [
          { label: 'Radius', value: `${num(body.radiusKm, 1)} km` },
          { label: 'Mass', value: `${body.massKg.toExponential(3)} kg` },
          { label: 'Density', value: `${body.densityGcm3} g/cm³` },
          { label: 'Gravity', value: `${body.gravity} m/s²` },
          { label: 'Escape velocity', value: `${body.escapeVelocityKms} km/s` },
          { label: 'Mean temperature', value: `${body.meanTempK} K` },
          {
            label: 'Sidereal day',
            value: `${num(Math.abs(body.rotationHours), 2)} h${body.rotationHours < 0 ? ' (retrograde)' : ''}`,
          },
          { label: 'Axial tilt', value: `${body.obliquityDeg}°` },
          { label: 'Bond albedo', value: body.albedo.toFixed(3) },
        ]
      : [
          {
            label: 'How big',
            value: `${num(body.radiusKm * 2)} km across`,
            hint: sizeComparison(body.radiusKm),
          },
          {
            label: 'How heavy you’d feel',
            value: `${(body.gravity / 9.807).toFixed(2)}×`,
            hint: `A 30 kg child would weigh ${(30 * (body.gravity / 9.807)).toFixed(0)} kg here`,
          },
          {
            label: 'How hot',
            value: `${Math.round(body.meanTempK - 273.15)} °C`,
            hint: temperatureFeel(body.meanTempK),
          },
          {
            label: 'How long a day is',
            value: dayLength(body.rotationHours),
          },
          {
            label: 'How tilted',
            value: `${body.obliquityDeg}°`,
            hint:
              body.obliquityDeg > 90 ? 'It’s tipped right over!' : undefined,
          },
        ];

  return (
    <motion.aside
      className="inspector pointer-events-auto"
      key={focused}
      initial={{ opacity: 0, y: 14, scale: 0.985 }}
      animate={{ opacity: 1, y: 0, scale: 1 }}
      transition={SPRING}
      aria-label={`About ${body.name}`}
    >
      <header className="inspector__head">
        <div>
          <p className="inspector__kicker">{copy.tagline[audience]}</p>
          <h1 className="inspector__title">{body.name}</h1>
        </div>
        <button
          className="inspector__collapse"
          onClick={() => setExpanded((v) => !v)}
          aria-expanded={expanded}
          aria-label={expanded ? 'Collapse details' : 'Expand details'}
        >
          <svg
            viewBox="0 0 24 24"
            width="16"
            height="16"
            aria-hidden="true"
            style={{
              transform: expanded ? 'rotate(0deg)' : 'rotate(180deg)',
              transition: 'transform .25s',
            }}
          >
            <path
              d="m6 14 6-6 6 6"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.8"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          </svg>
        </button>
      </header>

      <dl className="inspector__live">
        <div>
          <dt>Distance to camera</dt>
          <dd>
            <Live field="focusDistance" />
          </dd>
        </div>
        <div>
          <dt>Distance to Sun</dt>
          <dd>
            <Live field="sunDistance" />
          </dd>
        </div>
        <div>
          <dt>Sunlight takes</dt>
          <dd>
            <Live field="lightTime" />
          </dd>
        </div>
      </dl>

      <AnimatePresence initial={false}>
        {expanded && (
          <motion.div
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: 'auto', opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            transition={{ duration: 0.28, ease: [0.32, 0.72, 0, 1] }}
            style={{ overflow: 'hidden' }}
          >
            <p className="inspector__summary">{copy.summary[audience]}</p>

            <ul className="stat-grid">
              {stats.map((s) => (
                <li key={s.label}>
                  <span className="stat-grid__label">{s.label}</span>
                  <span className="stat-grid__value">{s.value}</span>
                  {s.hint && <span className="stat-grid__hint">{s.hint}</span>}
                </li>
              ))}
            </ul>

            {copy.facts.length > 0 && (
              <ul className="fact-list">
                {copy.facts.map((f, i) => (
                  <li key={i}>{f[audience]}</li>
                ))}
              </ul>
            )}

            {body.composition.length > 0 && (
              <div className="composition">
                <h2 className="composition__title">
                  {audience === 'explorer'
                    ? 'What it’s made of'
                    : 'Atmospheric composition'}
                </h2>
                <div
                  className="composition__bar"
                  role="img"
                  aria-label={body.composition
                    .map((c) => `${c.label} ${(c.fraction * 100).toFixed(1)}%`)
                    .join(', ')}
                >
                  {body.composition.map((c, i) => (
                    <span
                      key={c.label}
                      style={{
                        width: `${Math.max(c.fraction * 100, 0.8)}%`,
                        opacity: 1 - i * 0.16,
                      }}
                    />
                  ))}
                </div>
                <ul className="composition__legend">
                  {body.composition.map((c, i) => (
                    <li key={c.label}>
                      <span
                        style={{ opacity: 1 - i * 0.16 }}
                        aria-hidden="true"
                      />
                      {c.label}
                      <b>
                        {c.fraction >= 0.001
                          ? `${(c.fraction * 100).toFixed(1)}%`
                          : 'trace'}
                      </b>
                    </li>
                  ))}
                </ul>
              </div>
            )}
          </motion.div>
        )}
      </AnimatePresence>
    </motion.aside>
  );
}

function sizeComparison(radiusKm: number): string {
  const earths = radiusKm / 6371;
  if (earths > 1.15) return `About ${earths.toFixed(1)} times as wide as Earth`;
  if (earths > 0.85) return 'Almost exactly Earth-sized';
  return `You'd fit ${(1 / earths).toFixed(1)} of these across Earth`;
}

function temperatureFeel(k: number): string {
  if (k > 1000) return 'Hot enough to glow white';
  if (k > 600) return 'Hot enough to melt lead';
  if (k > 400) return 'Hotter than a pizza oven';
  if (k > 320) return 'Hotter than the hottest day on Earth';
  if (k > 283) return 'About like a mild day here';
  if (k > 263) return 'Around freezing';
  if (k > 210) return 'Colder than an Antarctic winter';
  if (k > 120) return 'Colder than anywhere on Earth has ever been';
  return 'So cold that air itself would freeze solid';
}

function dayLength(hours: number): string {
  const h = Math.abs(hours);
  const retro = hours < 0 ? ' (spinning backwards)' : '';
  if (h < 48) return `${h.toFixed(1)} hours${retro}`;
  return `${(h / 24).toFixed(1)} Earth days${retro}`;
}

// ----------------------------------------------------------------- timeline

function Timeline() {
  const [playing, setPlaying] = useState(simClock.playing);
  const [speedIndex, setSpeedIndex] = useState(3);
  const scaleTarget = useUIStore((s) => s.scaleTarget);
  const setScaleTarget = useUIStore((s) => s.setScaleTarget);
  const compact = useCompactLayout();

  const togglePlay = useCallback(() => {
    simClock.playing = !simClock.playing;
    setPlaying(simClock.playing);
    audio.select();
  }, []);

  const setSpeed = useCallback((i: number) => {
    setSpeedIndex(i);
    simClock.daysPerSecond = SPEED_PRESETS[i].daysPerSecond;
    if (SPEED_PRESETS[i].daysPerSecond !== 0) {
      simClock.playing = true;
      setPlaying(true);
    }
  }, []);

  return (
    <div className="timeline pointer-events-auto">
      {/* The wheel is the tallest thing in this row, so it sets the height of
          the whole bar. 52px still clears the 44px touch-target minimum. */}
      <JogWheel size={compact ? 52 : 92} />

      <div className="timeline__readout">
        <div className="timeline__date">
          <Live field="date" />
          <span className="timeline__clock">
            <Live field="time" />
          </span>
        </div>
        <div className="timeline__meta">
          <Live field="speed" />
          <span className="dot" aria-hidden="true">
            ·
          </span>
          <Live field="accuracy" />
        </div>
      </div>

      <div className="timeline__controls">
        <button
          className="play-button"
          onClick={togglePlay}
          aria-label={playing ? 'Pause' : 'Play'}
          aria-pressed={playing}
        >
          {playing ? (
            <svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true">
              <rect
                x="7"
                y="5"
                width="3.6"
                height="14"
                rx="1.2"
                fill="currentColor"
              />
              <rect
                x="13.4"
                y="5"
                width="3.6"
                height="14"
                rx="1.2"
                fill="currentColor"
              />
            </svg>
          ) : (
            <svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true">
              <path d="M8 5.5v13l11-6.5-11-6.5Z" fill="currentColor" />
            </svg>
          )}
        </button>

        <button
          className="ghost-button"
          onClick={() => {
            simClock.toNow();
            audio.select();
          }}
        >
          Today
        </button>

        <label className="speed-select">
          <span className="visually-hidden">Time speed</span>
          <select
            value={speedIndex}
            onChange={(e) => setSpeed(Number(e.target.value))}
          >
            {SPEED_PRESETS.map((p, i) => (
              <option key={p.label} value={i}>
                {p.label}
              </option>
            ))}
          </select>
        </label>
      </div>

      <div className="scale-morph">
        <span className="scale-morph__label">Scale</span>
        <input
          type="range"
          min={0}
          max={1}
          step={0.01}
          value={scaleTarget}
          onChange={(e) => setScaleTarget(Number(e.target.value))}
          aria-label="Blend between a compressed view and true scale"
          aria-valuetext={
            scaleTarget < 0.05
              ? 'Compressed'
              : scaleTarget > 0.95
                ? 'True scale'
                : `${Math.round(scaleTarget * 100)}% toward true scale`
          }
        />
        <span className="scale-morph__ends">
          <b>Easy to see</b>
          <b>Real distances</b>
        </span>
      </div>

      <CameraModeToggle />
    </div>
  );
}

function CameraModeToggle() {
  const mode = useUIStore((s) => s.cameraMode);
  const setMode = useUIStore((s) => s.setCameraMode);

  return (
    <div
      className="segmented segmented--compact"
      role="radiogroup"
      aria-label="Camera mode"
    >
      {(['orbit', 'free'] as const).map((m) => (
        <button
          key={m}
          role="radio"
          aria-checked={mode === m}
          className={`segmented__item${mode === m ? ' is-active' : ''}`}
          onClick={() => {
            setMode(m);
            audio.select();
          }}
        >
          {m === 'orbit' ? 'Orbit' : 'Free flight'}
        </button>
      ))}
    </div>
  );
}

// ------------------------------------------------------------------- panels

const LAYER_LABELS: Record<
  keyof OverlayFlags,
  { title: string; hint: string }
> = {
  orbits: {
    title: 'Orbit paths',
    hint: 'The route each planet takes around the Sun',
  },
  labels: { title: 'Name labels', hint: 'Floating names next to each world' },
  asteroids: {
    title: 'Asteroid belt',
    hint: 'The rocky band between Mars and Jupiter',
  },
  atmospheres: {
    title: 'Atmospheres',
    hint: 'The glowing edge of the air around a planet',
  },
  habitableZone: {
    title: 'Habitable zone',
    hint: 'Where liquid water could exist',
  },
  eclipticGrid: {
    title: 'Ecliptic grid',
    hint: 'The flat plane the planets orbit in',
  },
};

function LayersPanel() {
  const overlays = useUIStore((s) => s.overlays);
  const toggleOverlay = useUIStore((s) => s.toggleOverlay);

  return (
    <Panel title="Data layers">
      {(Object.keys(LAYER_LABELS) as Array<keyof OverlayFlags>).map((key) => (
        <label key={key} className="switch-row">
          <input
            type="checkbox"
            checked={overlays[key]}
            onChange={() => {
              toggleOverlay(key);
              audio.select();
            }}
          />
          <span className="switch-row__track" aria-hidden="true">
            <span />
          </span>
          <span className="switch-row__text">
            <b>{LAYER_LABELS[key].title}</b>
            <em>{LAYER_LABELS[key].hint}</em>
          </span>
        </label>
      ))}
    </Panel>
  );
}

function SettingsPanel() {
  const tier = useUIStore((s) => s.tier);
  const tierAuto = useUIStore((s) => s.tierAuto);
  const setTier = useUIStore((s) => s.setTier);
  const targetFps = useUIStore((s) => s.targetFps);
  const setTargetFps = useUIStore((s) => s.setTargetFps);
  const audioEnabled = useUIStore((s) => s.audioEnabled);
  const setAudioEnabled = useUIStore((s) => s.setAudioEnabled);
  const audioVolume = useUIStore((s) => s.audioVolume);
  const setAudioVolume = useUIStore((s) => s.setAudioVolume);
  const reducedMotion = useUIStore((s) => s.reducedMotion);
  const setReducedMotion = useUIStore((s) => s.setReducedMotion);
  const toggleDebugHud = useUIStore((s) => s.toggleDebugHud);

  return (
    <Panel title="Settings">
      <div className="field">
        <span className="field__label">Graphics quality</span>
        <div className="chip-row">
          <button
            className={`chip${tierAuto ? ' is-active' : ''}`}
            onClick={() => {
              quality.locked = false;
              setTier(quality.tierName, true);
            }}
          >
            Auto
          </button>
          {TIER_ORDER.map((t) => (
            <button
              key={t}
              className={`chip${!tierAuto && tier === t ? ' is-active' : ''}`}
              onClick={() => {
                quality.locked = true;
                quality.setTier(t as TierName, 'user');
                setTier(t as TierName, false);
              }}
            >
              {t[0].toUpperCase() + t.slice(1)}
            </button>
          ))}
        </div>
        <p className="field__hint">
          Auto watches the frame rate and adjusts. Currently running{' '}
          <b>{tier}</b>.
        </p>
      </div>

      <div className="field">
        <span className="field__label">Frame rate target</span>
        <div className="chip-row">
          {[30, 60, 120].map((f) => (
            <button
              key={f}
              className={`chip${targetFps === f ? ' is-active' : ''}`}
              onClick={() => {
                setTargetFps(f);
                quality.setTargetFps(f);
              }}
            >
              {f} fps
            </button>
          ))}
        </div>
      </div>

      <label className="switch-row">
        <input
          type="checkbox"
          checked={audioEnabled}
          onChange={(e) => {
            setAudioEnabled(e.target.checked);
            audio.setEnabled(e.target.checked);
          }}
        />
        <span className="switch-row__track" aria-hidden="true">
          <span />
        </span>
        <span className="switch-row__text">
          <b>Ambient sound</b>
          <em>A quiet drone that changes with each world</em>
        </span>
      </label>

      {audioEnabled && (
        <div className="field">
          <span className="field__label">Volume</span>
          <input
            type="range"
            min={0}
            max={1}
            step={0.01}
            value={audioVolume}
            onChange={(e) => {
              const v = Number(e.target.value);
              setAudioVolume(v);
              audio.setVolume(v);
            }}
            aria-label="Volume"
          />
        </div>
      )}

      <label className="switch-row">
        <input
          type="checkbox"
          checked={reducedMotion}
          onChange={(e) => setReducedMotion(e.target.checked)}
        />
        <span className="switch-row__track" aria-hidden="true">
          <span />
        </span>
        <span className="switch-row__text">
          <b>Reduce motion</b>
          <em>Camera moves jump straight to their destination</em>
        </span>
      </label>

      <button
        className="ghost-button ghost-button--wide"
        onClick={toggleDebugHud}
      >
        Toggle performance overlay
      </button>

      <p className="field__hint">
        Positions come from JPL Keplerian elements and are accurate to about an
        arcminute between 1800 and 2050. Outside that range the readout is
        marked <b>Extrapolated</b>.
      </p>
    </Panel>
  );
}

function Panel({
  title,
  children,
}: {
  title: string;
  children: React.ReactNode;
}) {
  const setPanel = useUIStore((s) => s.setPanel);
  return (
    <motion.div
      className="panel"
      initial={{ opacity: 0, y: -8, scale: 0.98 }}
      animate={{ opacity: 1, y: 0, scale: 1 }}
      exit={{ opacity: 0, y: -8, scale: 0.98 }}
      transition={SPRING}
      role="dialog"
      aria-label={title}
    >
      <header className="panel__head">
        <h2>{title}</h2>
        <button
          className="panel__close"
          onClick={() => setPanel(null)}
          aria-label="Close"
        >
          <svg viewBox="0 0 24 24" width="15" height="15" aria-hidden="true">
            <path
              d="m6 6 12 12M18 6 6 18"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.9"
              strokeLinecap="round"
            />
          </svg>
        </button>
      </header>
      <div className="panel__body">{children}</div>
    </motion.div>
  );
}

export const TOTAL_BODIES = BODIES.length;
export const SCENE_UNIT_KM = KM_PER_UNIT;
