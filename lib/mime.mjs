// Minimal MIME and text-type helper. Zero dependencies.

const MIME = {
  txt: "text/plain", md: "text/markdown", markdown: "text/markdown",
  json: "application/json", js: "text/javascript", mjs: "text/javascript",
  cjs: "text/javascript", jsx: "text/javascript", ts: "text/javascript",
  tsx: "text/javascript", css: "text/css", scss: "text/css", less: "text/css",
  html: "text/html", htm: "text/html", xml: "application/xml", yml: "text/yaml",
  yaml: "text/yaml", toml: "text/toml", ini: "text/plain", cfg: "text/plain",
  conf: "text/plain", log: "text/plain", csv: "text/csv", env: "text/plain",
  gitignore: "text/plain", gitattributes: "text/plain",
  sh: "text/x-shellscript", bash: "text/x-shellscript", zsh: "text/x-shellscript",
  py: "text/x-python", rb: "text/x-ruby", go: "text/x-go", rs: "text/x-rust",
  c: "text/x-c", h: "text/x-c", cc: "text/x-c", cpp: "text/x-c", hpp: "text/x-c",
  java: "text/x-java", kt: "text/x-kotlin", swift: "text/x-swift",
  php: "text/x-php", sql: "text/x-sql", r: "text/x-r", dart: "text/x-dart",
  lua: "text/x-lua", pl: "text/x-perl", ex: "text/x-elixir", exs: "text/x-elixir",
  ps1: "text/x-powershell", bat: "text/x-dos-batch", proto: "text/proto",
  svg: "image/svg+xml", png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg",
  gif: "image/gif", webp: "image/webp", avif: "image/avif", bmp: "image/bmp",
  ico: "image/x-icon", tiff: "image/tiff", heic: "image/heic",
  mp3: "audio/mpeg", wav: "audio/wav", ogg: "audio/ogg", oga: "audio/ogg",
  flac: "audio/flac", m4a: "audio/mp4", aac: "audio/aac", opus: "audio/opus",
  mp4: "video/mp4", webm: "video/webm", mov: "video/quicktime", mkv: "video/x-matroska",
  avi: "video/x-msvideo", m4v: "video/mp4", ogv: "video/ogg", ts: "video/mp2t",
  pdf: "application/pdf", zip: "application/zip", tar: "application/x-tar",
  gz: "application/gzip", bz2: "application/x-bzip2", xz: "application/x-xz",
  "7z": "application/x-7z-compressed", rar: "application/vnd.rar",
  epub: "application/epub+zip", doc: "application/msword",
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  xls: "application/vnd.ms-excel",
  xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  ppt: "application/vnd.ms-powerpoint",
  pptx: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  woff: "font/woff", woff2: "font/woff2", ttf: "font/ttf", otf: "font/otf",
  wasm: "application/wasm", bin: "application/octet-stream", exe: "application/octet-stream",
  dmg: "application/octet-stream", iso: "application/octet-stream",
  deb: "application/vnd.debian.binary-package", rpm: "application/x-rpm"
};

// Extensions we treat as readable text in the editor / preview.
const TEXT_EXTS = new Set(Object.keys(MIME).filter((e) =>
  MIME[e].startsWith("text/") || MIME[e].startsWith("application/json") ||
  MIME[e].startsWith("image/svg") || MIME[e].startsWith("application/xml") ||
  MIME[e] === "text/yaml" || MIME[e] === "text/toml"
));

export function mimeFor(name) {
  const i = name.lastIndexOf(".");
  if (i === -1) return "";
  const ext = name.slice(i + 1).toLowerCase();
  return MIME[ext] || "";
}

export function isTextName(name) {
  const i = name.lastIndexOf(".");
  if (i === -1) return false;
  return TEXT_EXTS.has(name.slice(i + 1).toLowerCase());
}

export const MAX_TEXT = 8 * 1024 * 1024; // 8 MB text read cap
