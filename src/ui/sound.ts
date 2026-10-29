/**
 * Короткий сигнал о новом сообщении. Синтезируется Web Audio — без аудиофайлов, поэтому
 * отдельных разрешений в CSP (media-src) не нужно.
 *
 * Браузер разрешает звук только после того, как посетитель хоть раз взаимодействовал со страницей.
 * До этого сигнал молча не играет — это нормально.
 */
type AudioCtx = AudioContext;

let ctx: AudioCtx | null = null;

function context(): AudioCtx | null {
  if (ctx) return ctx;
  const Ctor = (globalThis as { AudioContext?: typeof AudioContext; webkitAudioContext?: typeof AudioContext }).AudioContext ??
    (globalThis as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
  if (!Ctor) return null;
  try {
    ctx = new Ctor();
  } catch {
    return null;
  }
  return ctx;
}

export function playPing(): void {
  const c = context();
  if (!c) return;
  const play = () => {
    const t0 = c.currentTime;
    // Два коротких тона вверх — привычный «дзынь» мессенджеров, тихий.
    [
      [880, 0],
      [1320, 0.09],
    ].forEach(([freq, offset]) => {
      const osc = c.createOscillator();
      const gain = c.createGain();
      osc.type = 'sine';
      osc.frequency.value = freq;
      gain.gain.setValueAtTime(0.0001, t0 + offset);
      gain.gain.exponentialRampToValueAtTime(0.08, t0 + offset + 0.01);
      gain.gain.exponentialRampToValueAtTime(0.0001, t0 + offset + 0.16);
      osc.connect(gain).connect(c.destination);
      osc.start(t0 + offset);
      osc.stop(t0 + offset + 0.18);
    });
  };
  if (c.state === 'running') play();
  else c.resume().then(play, () => {});
}
