export const SOUND_STORAGE_KEY = 'kamkmchess.sound.v1';
export type SoundCue = 'win' | 'loss' | 'draw';

interface Note { readonly hz: number; readonly seconds: number }

// Short triangle-wave motifs, played in sequence 40ms apart.
const CUES: Record<SoundCue, readonly Note[]> = {
  win: [{ hz: 587.33, seconds: 0.17 }, { hz: 880, seconds: 0.17 }],
  loss: [{ hz: 392, seconds: 0.2 }, { hz: 261.63, seconds: 0.2 }],
  draw: [{ hz: 440, seconds: 0.26 }],
};
const PEAK_GAIN = 0.14;
const FLOOR_GAIN = 0.0001;
const NOTE_GAP_SECONDS = 0.04;
const ATTACK_SECONDS = 0.012;

let context: AudioContext | null = null;

/** Result sounds are on unless the player turned them off. */
export function isSoundEnabled(): boolean {
  try { return window.localStorage.getItem(SOUND_STORAGE_KEY) !== 'off'; }
  catch { return true; }
}

export function setSoundEnabled(enabled: boolean): void {
  try { window.localStorage.setItem(SOUND_STORAGE_KEY, enabled ? 'on' : 'off'); }
  catch { /* The choice still applies for this page when browser storage is unavailable. */ }
}

/** Plays a synthesized result cue. Never throws: a missing or blocked audio device must not affect the game. */
export function playResultSound(cue: SoundCue): void {
  try {
    if (!isSoundEnabled()) return;
    context ??= new AudioContext();
    const audio = context;
    void audio.resume();
    let start = audio.currentTime;
    for (const { hz, seconds } of CUES[cue]) {
      const oscillator = audio.createOscillator();
      const gain = audio.createGain();
      oscillator.type = 'triangle';
      oscillator.frequency.value = hz;
      gain.gain.setValueAtTime(FLOOR_GAIN, start);
      gain.gain.exponentialRampToValueAtTime(PEAK_GAIN, start + ATTACK_SECONDS);
      gain.gain.exponentialRampToValueAtTime(FLOOR_GAIN, start + seconds);
      oscillator.connect(gain).connect(audio.destination);
      oscillator.start(start);
      oscillator.stop(start + seconds);
      start += seconds + NOTE_GAP_SECONDS;
    }
  } catch { /* Sound is optional. */ }
}
