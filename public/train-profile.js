(() => {
  function now() {
    return typeof performance !== "undefined" && performance.now ? performance.now() : Date.now();
  }

  function createProfiler() {
    const nodes = new Map();
    const stack = [];

    function record(path) {
      let node = nodes.get(path);
      if (!node) {
        node = { path, inclusive: 0, exclusive: 0, count: 0, max: 0 };
        nodes.set(path, node);
      }
      return node;
    }

    function begin(name) {
      const t = now();
      const parent = stack[stack.length - 1];
      const path = parent ? `${parent.path}/${name}` : name;
      stack.push({ name, path, t, childTime: 0 });
    }

    function end() {
      const t = now();
      const item = stack.pop();
      if (!item) return;
      const inclusive = t - item.t;
      const exclusive = Math.max(0, inclusive - item.childTime);
      const node = record(item.path);
      node.inclusive += inclusive;
      node.exclusive += exclusive;
      node.count += 1;
      if (inclusive > node.max) node.max = inclusive;
      const parent = stack[stack.length - 1];
      if (parent) parent.childTime += inclusive;
    }

    function span(name, fn) {
      begin(name);
      try {
        const result = fn();
        if (result && typeof result.then === "function") {
          return Promise.resolve(result).finally(() => end());
        }
        end();
        return result;
      } catch (error) {
        end();
        throw error;
      }
    }

    function reset() {
      nodes.clear();
      stack.length = 0;
    }

    function report() {
      return [...nodes.values()]
        .map((node) => ({
          path: node.path,
          inclusiveMs: node.inclusive,
          exclusiveMs: node.exclusive,
          count: node.count,
          avgMs: node.inclusive / Math.max(1, node.count),
          maxMs: node.max,
          depth: node.path.split("/").length - 1
        }))
        .sort((a, b) => b.inclusiveMs - a.inclusiveMs);
    }

    function format(totalMs) {
      const rows = report();
      const width = rows.reduce((max, row) => Math.max(max, row.path.length), 8);
      const header = `${"path".padEnd(width)}  incl_ms  excl_ms  count   avg_ms   max_ms   incl_%`;
      const lines = [header, "-".repeat(header.length)];
      const rootTotal = rows.filter((row) => row.depth === 0).reduce((sum, row) => sum + row.inclusiveMs, 0);
      const total = totalMs || rootTotal || 1;
      rows.forEach((row) => {
        const indent = row.path;
        lines.push(
          `${indent.padEnd(width)}  ${row.inclusiveMs.toFixed(2).padStart(7)}  ${row.exclusiveMs
            .toFixed(2)
            .padStart(7)}  ${String(row.count).padStart(5)}  ${row.avgMs.toFixed(2).padStart(7)}  ${row.maxMs
            .toFixed(2)
            .padStart(7)}  ${((100 * row.inclusiveMs) / total).toFixed(1).padStart(6)}`
        );
      });
      return lines.join("\n");
    }

    return { begin, end, span, reset, report, format };
  }

  const root = typeof window !== "undefined" ? window : self;
  root.TrainProfile = { createProfiler };
})();
