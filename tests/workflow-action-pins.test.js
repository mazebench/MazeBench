const assert = require("assert");
const fs = require("fs");
const path = require("path");

const workflowsDir = path.join(__dirname, "..", ".github", "workflows");
const workflowFiles = fs
  .readdirSync(workflowsDir)
  .filter((name) => name.endsWith(".yml") || name.endsWith(".yaml"))
  .sort();

let actionCount = 0;
for (const workflowFile of workflowFiles) {
  const source = fs.readFileSync(path.join(workflowsDir, workflowFile), "utf8");
  const usesLines = source.match(/^\s*(?:-\s*)?uses:\s*\S+.*$/gm) || [];
  let parsedUsesLines = 0;
  const usesPattern = /^\s*(?:-\s*)?uses:\s*([^@\s]+)@([^\s#]+)(?:\s+#\s*(.+))?\s*$/gm;
  for (const match of source.matchAll(usesPattern)) {
    const [, action, revision, comment = ""] = match;
    parsedUsesLines += 1;
    if (action.startsWith("./")) {
      continue;
    }

    actionCount += 1;
    assert.match(
      revision,
      /^[0-9a-f]{40}$/,
      `${workflowFile}: ${action} must use an immutable 40-character commit SHA`
    );
    assert.match(
      comment,
      /\bv\d+(?:\.\d+){1,2}\b/,
      `${workflowFile}: ${action}@${revision} must retain its human-readable release tag`
    );
  }
  assert.equal(
    parsedUsesLines,
    usesLines.length,
    `${workflowFile}: every uses declaration must use an explicit action@revision`
  );
}

assert.ok(actionCount > 0, "expected to validate at least one external action");
console.log(`workflow-action-pins: validated ${actionCount} immutable action references`);
