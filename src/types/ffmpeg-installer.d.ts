declare module '@ffmpeg-installer/ffmpeg' {
  /** Absolute path to the ffmpeg binary */
  export const path: string;
  /** Version of the ffmpeg binary */
  export const version: string;
  /** URL the binary was downloaded from */
  export const url: string;
}
