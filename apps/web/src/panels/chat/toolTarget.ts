export interface CommandTarget {
  context?: string;
  namespace?: string;
}

/** Parse the kube context + namespace a chat command targeted, from the command string. */
export function parseCommandTarget(command?: string): CommandTarget {
  if (!command) return {};
  const target: CommandTarget = {};
  const context = command.match(/--context[=\s]+(\S+)/)?.[1];
  if (context) target.context = context;
  const namespace = command.match(/(?:-n|--namespace)[=\s]+(\S+)/)?.[1];
  if (namespace) target.namespace = namespace;
  return target;
}
