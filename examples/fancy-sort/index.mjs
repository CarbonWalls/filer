import path from "node:path";

function titlecase(name) {
  return name.replace(/(^|[\s._-])([a-z])/g, (m, p, c) => p + c.toUpperCase());
}

export default {
  async init(ctx) {
    // Override fs.list: delegate to the core implementation via next(),
    // then re-sort by size (directories first, then files by size desc).
    ctx.handle("fs.list", async ({ path: p }, next) => {
      const base = await next({ path: p });
      const order = (a, b) => {
        const ad = a.kind === "dir" ? 1 : 0;
        const bd = b.kind === "dir" ? 1 : 0;
        if (ad !== bd) return bd - ad;
        return (b.size || 0) - (a.size || 0);
      };
      base.entries.sort(order);
      return base;
    });

    // Add a custom command (appears in the right-click menu).
    ctx.command({
      id: "fancy.titlecase",
      label: "Titlecase Name",
      icon: "type",
      async run(entry) {
        if (!entry || !entry.path) throw new Error("Select a file first");
        const dir = path.dirname(entry.path);
        const nn = titlecase(entry.name);
        await ctx.call("fs.rename", { from: entry.path, to: path.join(dir, nn) });
        return `Renamed to ${nn}`;
      },
    });
  },
};
