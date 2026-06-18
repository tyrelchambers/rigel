// Hand-rolled manifest tidy for the live-resource editor — no YAML dependency in
// the bundle (matches the project's other hand-rolled YAML editors). Removes the
// top-level `status:` block (server-computed, not meant to be edited/applied).
// managedFields are excluded upstream via `kubectl get --show-managed-fields=false`.

/** Drop a top-level `status:` mapping from single-doc `kubectl get -o yaml`
 *  output. A top-level key sits at column 0; the block runs until the next
 *  column-0 key or EOF. An indented `status:` (a data/spec key) is left alone. */
export function stripStatusBlock(yaml: string): string {
  const out: string[] = [];
  let skipping = false;
  for (const line of yaml.split("\n")) {
    if (skipping) {
      if (line === "" || /^\s/.test(line)) continue; // still inside status:
      skipping = false; // a new column-0 key ends the block
    }
    if (/^status:(\s|$)/.test(line)) {
      skipping = true;
      continue;
    }
    out.push(line);
  }
  // Preserve the input's trailing newline when a final status: block consumed it.
  const result = out.join("\n");
  return yaml.endsWith("\n") && !result.endsWith("\n") ? result + "\n" : result;
}
