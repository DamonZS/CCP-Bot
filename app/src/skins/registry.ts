import { appConfig } from "@/lib/generated/application-config";
import { opendots } from "./opendots";
import { openduet } from "./openduet";
import { openmuse } from "./openmuse";
import { useSkinId } from "./store";
import type { Skin, SkinId } from "./types";
import { t } from "@/lib/i18n";

/*
 * The default is the product as `brand.yaml` names it, so a deployment that renames CCP-Bot sees
 * its own name here too. The description says nothing a rename could make untrue.
 */
const ccpbot: Skin = {
  id: "ccpbot",
  name: appConfig.brand.productName,
  description: t("The standard look, with your conversations in a sidebar."),
};

/** Keyed by every id in `SKIN_IDS`, so a skin cannot be listed without being registered. */
export const SKINS: Record<SkinId, Skin> = {
  ccpbot,
  openduet,
  opendots,
  openmuse,
};

export function useActiveSkin(): Skin {
  return SKINS[useSkinId()];
}
