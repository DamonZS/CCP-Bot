import {
  IconBuildingBank,
  IconChecks,
  IconChevronRight,
  IconCode,
  IconDeviceDesktop,
  IconFileText,
  IconKey,
  IconLayoutGrid,
  IconListDetails,
  IconPuzzle,
  IconShieldCheck,
  IconUsers,
} from "@tabler/icons-react";
import {
  createFileRoute,
  Link,
  type LinkOptions,
} from "@tanstack/react-router";
import {
  PageRows,
  PageSection,
  PageShell,
} from "@/components/layout/page-shell";
import { StaggerItem } from "@/components/layout/stagger";
import {
  Item,
  ItemContent,
  ItemDescription,
  ItemMedia,
  ItemTitle,
} from "@/components/ui/item";
import { Separator } from "@/components/ui/separator";
import { t } from "@/lib/i18n";

export const Route = createFileRoute("/_authed/admin/")({
  component: RouteComponent,
});

/**
 * Grouped by what the decision is about rather than by how the code is organised.
 *
 * "What Bots can reach" is the group an administrator arrives worrying about, so it goes first.
 * Everything in it either grants a capability or fences one in.
 */
const SECTIONS: {
  title: string;
  description: string;
  items: {
    description: string;
    icon: React.ComponentType<{ className?: string }>;
    linkOptions: LinkOptions;
    title: string;
  }[];
}[] = [
  {
    title: t("What Bots can reach"),
    description: t("Control what Bots can access outside OpenBot."),
    items: [
      {
        title: t("Credentials"),
        description: t("Manage this deployment’s keys and tokens."),
        icon: IconKey,
        linkOptions: { to: "/admin/credentials" },
      },
      {
        title: t("Boundaries"),
        description: t("Define actions that no Bot may take."),
        icon: IconShieldCheck,
        linkOptions: { to: "/admin/boundaries" },
      },
      {
        title: t("Approvals"),
        description: t("Choose which actions require approval for members’ Bots."),
        icon: IconChecks,
        linkOptions: { to: "/admin/approvals" },
      },
      {
        title: t("Computers"),
        description: t("Manage the computers that run Bot tools."),
        icon: IconDeviceDesktop,
        linkOptions: { to: "/admin/computers" },
      },
    ],
  },
  {
    title: t("What Bots can do"),
    description:
      t("Configure the apps, skills, and UI components available to Bots."),
    items: [
      {
        title: t("Plugins"),
        description: t("Connect services and choose which Bots can use them."),
        icon: IconPuzzle,
        linkOptions: { to: "/admin/plugins" },
      },
      {
        title: t("Skills"),
        description: t("Create reusable instructions people can run with /."),
        icon: IconFileText,
        linkOptions: { to: "/admin/skills" },
      },
      {
        title: t("Automatic learning"),
        description:
          t("Learn from finished conversations and review the skills it proposes."),
        icon: IconFileText,
        linkOptions: { to: "/admin/learning" },
      },
      {
        title: t("UI components"),
        description:
          t("Manage custom components that Bots can display in conversations."),
        icon: IconLayoutGrid,
        linkOptions: { to: "/admin/components" },
      },
      {
        title: t("Playground"),
        description: t("Write a component and watch it render as you type."),
        icon: IconCode,
        linkOptions: { to: "/admin/playground" },
      },
    ],
  },
  {
    title: t("Who can get in"),
    description: "",
    items: [
      {
        title: t("People"),
        description: t("Review members, manage admin roles, and remove access."),
        icon: IconUsers,
        linkOptions: { to: "/admin/people" },
      },
      {
        title: t("Enterprise controls"),
        description:
          t("Configure roles, groups, SSO, SCIM, Skill sharing, network policies, allowlists, and Action Recording."),
        icon: IconShieldCheck,
        linkOptions: { to: "/admin/enterprise" },
      },
      {
        title: t("Identity providers"),
        description:
          t("Configure your company’s sign-in provider for each email domain."),
        icon: IconBuildingBank,
        linkOptions: { to: "/admin/identity-providers" },
      },
    ],
  },
  {
    title: t("What happened"),
    description: "",
    items: [
      {
        title: t("Audit"),
        description: t("Review actions taken in OpenBot and who took them."),
        icon: IconListDetails,
        linkOptions: { to: "/admin/audit" },
      },
    ],
  },
];

function RouteComponent() {
  return (
    <PageShell
      description={t("Manage settings that apply to everyone and every Bot in this deployment.")}
      title={t("Admin")}
    >
      {SECTIONS.map((section) => (
        <PageSection
          description={section.description || undefined}
          key={section.title}
          title={section.title}
        >
          <PageRows>
            {section.items.map((item, index) => (
              <StaggerItem index={index} key={item.title}>
                {/*
                 * The whole row is the link, not a chevron somebody has to aim at: every row here
                 * goes exactly one place, so there is nothing else the row could mean.
                 */}
                <Item
                  render={(props) => <Link {...item.linkOptions} {...props} />}
                  size="sm"
                >
                  <ItemMedia variant="icon">
                    <item.icon />
                  </ItemMedia>
                  <ItemContent>
                    <ItemTitle>{item.title}</ItemTitle>
                    <ItemDescription>{item.description}</ItemDescription>
                  </ItemContent>
                  <IconChevronRight className="size-4 shrink-0 text-muted-foreground" />
                </Item>
                {index !== section.items.length - 1 && <Separator />}
              </StaggerItem>
            ))}
          </PageRows>
        </PageSection>
      ))}
    </PageShell>
  );
}
