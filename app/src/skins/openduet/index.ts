import type { Skin } from "../types";
import { OpenDuetFrame } from "./frame";
import { TASKS_SCREEN } from "./places";
import { TasksScreen } from "./tasks-screen";
import { t } from "@/lib/i18n";

export const openduet: Skin = {
  id: "openduet",
  name: "OpenDuet",
  description: t(
    "Bots that keep you in the loop, in a column shaped like a phone.",
  ),
  Frame: OpenDuetFrame,
  screens: { [TASKS_SCREEN]: TasksScreen },
};
