import { createFileRoute } from "@tanstack/react-router";
import { BotSubpage } from "@/components/bot-profile/bot-subpage";
import { ReachingYou } from "@/components/delivery/reaching-you";
import { t } from "@/lib/i18n";

export const Route = createFileRoute("/_authed/_app/bots/$agentId/reach")({
  component: ReachPage,
});

function ReachPage() {
  const { agentId } = Route.useParams();
  return (
    <BotSubpage
      agentId={agentId}
      description={t("Continue a conversation with this Bot in Slack, Microsoft Teams, or by text message.")}
      title={t("Reaching you")}
    >
      {(agent) => <ReachingYou agentId={agent.id} />}
    </BotSubpage>
  );
}
