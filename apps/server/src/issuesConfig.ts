// Per-cluster issue mutes, stored in the rigel-user-config Secret alongside the
// voice and agent config. A mute belongs to the cluster whose issue it silences,
// so it follows that cluster rather than the machine it was set from.
import { ISSUES_CONFIG_KEY } from "@rigel/k8s/src/userConfig";
import { parseIssueMutes, serializeIssueMutes, type IssueMutes } from "@rigel/k8s/src/issues/mutes";
import { readUserConfig, writeUserConfig } from "./clusterConfigStore";

/** Every mute stored for this cluster. Nothing stored reads as no mutes. */
export async function readIssueMutes(context: string | null): Promise<IssueMutes> {
  const read = await readUserConfig(context);
  return parseIssueMutes(read.data[ISSUES_CONFIG_KEY]);
}

/** Replace the stored map wholesale. The renderer holds the whole map, so a
 *  merge here would resurrect a mute it had just cleared. */
export async function writeIssueMutes(context: string | null, mutes: IssueMutes): Promise<void> {
  await writeUserConfig(context, () => ({ [ISSUES_CONFIG_KEY]: serializeIssueMutes(mutes) }));
}
