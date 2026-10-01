// Settings for `web-ext` (npm run chrome / firefox / build / lint).
export default {
  sourceDir: 'extension',
  artifactsDir: 'dist',
  build: { overwriteDest: true },
  run: { startUrl: ['http://localhost:8080/'] },
};
