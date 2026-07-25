import { createContext, useContext } from "react";

/**
 * Lets a flow body know it is running inside the onboarding wizard rather than
 * in its own dialog. Hosted bodies give up their own title and action row: the
 * wizard renders the head, and the body's primary action goes into the wizard
 * footer so the card has exactly one action row. Outside the wizard the context
 * is null and every body renders itself whole, which is what the cluster rail's
 * standalone dialogs still rely on.
 */
export interface WizardHost {
  /** The wizard footer node a hosted body portals its primary action into. */
  actionSlot: HTMLElement | null;
  /**
   * A step reports that a sub-flow has taken over its body. `ownsAction` says
   * whether that flow hoists a single primary into the footer: the cloud connect
   * flow is a wizard of its own with a button per step and nothing to hoist, so
   * it takes the head but leaves the footer alone rather than emptying it.
   */
  setSubflow: (open: boolean, ownsAction: boolean) => void;
}

export const WizardHostContext = createContext<WizardHost | null>(null);

export function useWizardHost(): WizardHost | null {
  return useContext(WizardHostContext);
}
