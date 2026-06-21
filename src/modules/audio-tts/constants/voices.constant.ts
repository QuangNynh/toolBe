/**
 * Supported Gemini TTS voices for gemini-3.1-flash-tts-preview.
 *
 * Each voice has a unique character/style and gender classification.
 * See: https://ai.google.dev/gemini-api/docs/text-to-speech
 */
export interface GeminiVoice {
  /** Voice identifier used in the API (e.g. 'Kore') */
  id: string;
  /** Gender classification */
  gender: string;
  /** Voice character / style description */
  character: string;
}

export const GEMINI_VOICES: GeminiVoice[] = [
  { id: 'Zephyr', gender: 'Female', character: 'Bright' },
  { id: 'Puck', gender: 'Male', character: 'Upbeat' },
  { id: 'Charon', gender: 'Male', character: 'Informative' },
  { id: 'Kore', gender: 'Female', character: 'Firm' },
  { id: 'Fenrir', gender: 'Male', character: 'Excitable' },
  { id: 'Leda', gender: 'Female', character: 'Youthful' },
  { id: 'Orus', gender: 'Male', character: 'Firm' },
  { id: 'Aoede', gender: 'Female', character: 'Breezy' },
  { id: 'Callirrhoe', gender: 'Female', character: 'Easy-going' },
  { id: 'Autonoe', gender: 'Female', character: 'Bright' },
  { id: 'Enceladus', gender: 'Male', character: 'Breathy' },
  { id: 'Iapetus', gender: 'Male', character: 'Clear' },
  { id: 'Umbriel', gender: 'Male', character: 'Easy-going' },
  { id: 'Algieba', gender: 'Male', character: 'Smooth' },
  { id: 'Despina', gender: 'Female', character: 'Smooth' },
  { id: 'Erinome', gender: 'Female', character: 'Clear' },
  { id: 'Gacrux', gender: 'Male', character: 'Mature' },
  { id: 'Laomedeia', gender: 'Female', character: 'Upbeat' },
  { id: 'Pulcherrima', gender: 'Female', character: 'Forward' },
  { id: 'Sulafat', gender: 'Male', character: 'Warm' },
  { id: 'Vindemiatrix', gender: 'Female', character: 'Gentle' },
  { id: 'Zubenelgenubi', gender: 'Male', character: 'Casual' },
  { id: 'Achernar', gender: 'Female', character: 'Soft' },
  { id: 'Schedar', gender: 'Male', character: 'Even' },
  { id: 'Rasalgethi', gender: 'Male', character: 'Informative' },
  { id: 'Sadachbia', gender: 'Male', character: 'Lively' },
  { id: 'Sadaltager', gender: 'Male', character: 'Knowledgeable' },
  { id: 'Sargas', gender: 'Male', character: 'Direct' },
];
