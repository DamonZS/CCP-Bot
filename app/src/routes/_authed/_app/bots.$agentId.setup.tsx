import { createFileRoute } from "@tanstack/react-router";
import { BotSubpage } from "@/components/bot-profile/bot-subpage";
import { SetupSections } from "@/components/bot-profile/setup";
import { t } from "@/lib/i18n";

export const Route = createFileRoute("/_authed/_app/bots/$agentId/setup")({
  component: SetupPage,
});

function SetupPage() {
  const { agentId } = Route.useParams();
  return (
    <BotSubpage
      agentId={agentId}
      description={t("Edit this Bot’s profile, visibility, and runtime settings.")}
      title={t("Setup")}
    >
      {(agent) => <SetupSections agent={agent} />}
    </BotSubpage>
  );
}
