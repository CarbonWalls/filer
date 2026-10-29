export default {
  async init(ctx) {
    const img = /\.(png|jpe?g|gif|webp|avif|bmp|ico|tiff?|heic|svg)$/i;
    const vid = /\.(mp4|webm|mov|mkv|avi|m4v|ogv)$/i;
    const aud = /\.(mp3|wav|ogg|oga|flac|m4a|aac|opus)$/i;
    // order matters: most specific tests first, generic fallback last
    ctx.view(img, { type: "image", title: "Image" });
    ctx.view(vid, { type: "video", title: "Video" });
    ctx.view(aud, { type: "audio", title: "Audio" });
    ctx.view(/\.pdf$/i, { type: "pdf", title: "PDF" });
    ctx.view(/\.(md|markdown)$/i, { type: "markdown", title: "Markdown" });
    ctx.view(
      /\.(txt|json|js|mjs|cjs|jsx|ts|tsx|css|scss|less|html?|xml|ya?ml|toml|ini|cfg|conf|log|csv|env|gitignore|gitattributes|sh|bash|zsh|py|rb|go|rs|c|h|cc|cpp|hpp|java|kt|swift|php|sql|r|dart|lua|pl|ex|exs|ps1|bat|proto)$/i,
      { type: "text", title: "Text" }
    );
    ctx.view(/./, { type: "binary", title: "Binary" });

    // The editor / preview UI itself is built into the client; these view
    // registrations just tell it how to render each file type.
  },
};
