import { useState } from "react";
import { UpgradeBanner } from "@/shell/billing/UpgradeBanner";
import { useEntitlement } from "@/shell/useEntitlement";
import { useUpgrade } from "@/shell/UpgradeContext";
import { useAccount } from "@/shell/useAccount";
import { FREE_PUBLIC_BETA } from "@/lib/beta";

const DISMISS_KEY = "rigel.overview.upgradeDismissed";

/** The free-plan upsell, moved off onboarding. A returning user knows what the
 *  paid features are; a brand-new one does not. Dismissal is permanent. */
export function UpgradeCard() {
  const { payload } = useEntitlement();
  const { openUpgrade } = useUpgrade();
  const { orgs } = useAccount();
  const [dismissed, setDismissed] = useState(() => {
    try { return localStorage.getItem(DISMISS_KEY) === "1"; } catch { return false; }
  });

  if (FREE_PUBLIC_BETA || dismissed || payload == null || payload.plan === "pro") return null;

  const personalOrgId = orgs.find((o) => o.kind === "personal")?.id;
  return (
    <div className="ov-row">
      <UpgradeBanner
        upgradeDisabled={!personalOrgId}
        onUpgrade={openUpgrade}
        onDismiss={() => {
          try { localStorage.setItem(DISMISS_KEY, "1"); } catch { /* ignore quota / private-browsing errors */ }
          setDismissed(true);
        }}
      />
    </div>
  );
}
