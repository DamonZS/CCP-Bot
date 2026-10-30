import { createFileRoute } from "@tanstack/react-router";
import { TeamApprovalSettings } from "@/components/approvals/team-settings";
import { PageShell } from "@/components/layout/page-shell";
import { t } from "@/lib/i18n";

export const Route = createFileRoute("/_authed/admin/approvals")({
  component: AdminApprovalsPage,
});

function AdminApprovalsPage() {
  return (
    <PageShell
      description={t(
        "Set approval rules for members’ Bots and review requests to use shared accounts.",
      )}
      title={t("Approvals")}
    >
      <TeamApprovalSettings />
    </PageShell>
  );
}
