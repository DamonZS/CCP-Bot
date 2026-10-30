import { createFileRoute } from "@tanstack/react-router";
import { AccessSections } from "@/components/bot-profile/access";
import { BotSubpage } from "@/components/bot-profile/bot-subpage";
import { t } from "@/lib/i18n";

export const Route = createFileRoute("/_authed/_app/bots/$agentId/access")({
  component: AccessPage,
});

function AccessPage() {
  const { agentId } = Route.useParams();
  return (
    <BotSubpage
      agentId={agentId}
      description={t(
        "Manage the skills, apps, and other Bots this Bot can use.",
      )}
      title={t("Skills and access")}
    >
      {(agent) => <AccessSections agent={agent} />}
    </BotSubpage>
  );
}
