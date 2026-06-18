// File → YAML text for the Apply panel's upload / drag-drop. Pure + tiny so the
// panel wiring stays thin and this stays unit-testable.

/** True for .yaml / .yml filenames (case-insensitive). */
export function isYamlFilename(name: string): boolean {
  return /\.ya?ml$/i.test(name.trim());
}

/** Read a dropped/selected file's text. Rejects non-YAML extensions so a binary
 *  or JSON blob isn't silently dumped into the manifest editor. */
export async function readYamlFile(file: File): Promise<string> {
  if (!isYamlFilename(file.name)) {
    throw new Error(`${file.name} is not a .yaml/.yml file`);
  }
  return file.text();
}
