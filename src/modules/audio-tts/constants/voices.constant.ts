/**
 * VieNeu-TTS voice configuration.
 *
 * These voices are available from the VieNeu-TTS local server.
 * The list is fetched dynamically from the server at startup,
 * but we keep a static fallback list for offline/initial display.
 *
 * See: https://github.com/pnnbao97/VieNeu-TTS
 */
export interface VieneuVoice {
  /** Voice identifier used in the API */
  id: string;
  /** Human-readable voice label */
  label: string;
  /** Gender classification */
  gender: string;
  /** Voice character / style description */
  character: string;
}

/**
 * Static fallback list of VieNeu-TTS v3 Turbo preset voices.
 * The actual list is fetched dynamically from the VieNeu-TTS server.
 */
export const VIENEU_DEFAULT_VOICES: VieneuVoice[] = [
  { id: 'Ngọc Lan', label: 'Ngọc Lan', gender: 'Female', character: 'Dịu dàng' },
  { id: 'Gia Bảo', label: 'Gia Bảo', gender: 'Male', character: 'Mượt mà' },
  { id: 'Thái Sơn', label: 'Thái Sơn', gender: 'Male', character: 'Chắc khỏe' },
  { id: 'Đức Trí', label: 'Đức Trí', gender: 'Male', character: 'Rõ ràng' },
  { id: 'Mỹ Duyên', label: 'Mỹ Duyên', gender: 'Female', character: 'Mượt mà' },
  { id: 'Trúc Ly', label: 'Trúc Ly', gender: 'Female', character: 'Trẻ trung' },
  { id: 'Xuân Vĩnh', label: 'Xuân Vĩnh', gender: 'Male', character: 'Vui tươi' },
  { id: 'Trọng Hữu', label: 'Trọng Hữu', gender: 'Male', character: 'Uyên bác' },
  { id: 'Bình An', label: 'Bình An', gender: 'Male', character: 'Điềm đạm' },
  { id: 'Ngọc Linh', label: 'Ngọc Linh', gender: 'Female', character: 'Tươi sáng' },
];
