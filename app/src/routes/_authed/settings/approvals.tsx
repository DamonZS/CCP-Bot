import { createFileRoute } from "@tanstack/react-router";
import { ApprovalSettings } from "@/components/approvals/settings";
import { PageShell } from "@/components/layout/page-shell";
import { TeamBotConsents } from "@/components/settings/team-bot-consents";
import { t } from "@/lib/i18n";

export const Route = createFileRoute("/_authed/settings/approvals")({
  component: ApprovalsSettingsPage,
});

function ApprovalsSettingsPage() {
  return (
    <PageShell
      description={t(
        "Choose when your Bots ask before they change things. Rules here apply to all of them.",
      )}
      title={t("Approvals")}
    >
      <ApprovalSettings />
      <TeamBotConsents />
    </PageShell>
  );
}
