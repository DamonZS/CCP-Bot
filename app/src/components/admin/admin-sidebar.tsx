import {
  IconArrowLeft,
  IconBuildingBank,
  IconChecks,
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
import { Link, type LinkOptions } from "@tanstack/react-router";
import type * as React from "react";
import {
  Sidebar,
  SidebarContent,
  SidebarGroup,
  SidebarGroupLabel,
  SidebarHeader,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarRail,
} from "@/components/ui/sidebar";
import { t } from "@/lib/i18n";

const appLinkOptions = { to: "/" } satisfies LinkOptions;
const adminLinkOptions = { to: "/admin" } satisfies LinkOptions;

/**
 * The same four groups, in the same order, as the admin index.
 *
 * A rail that lists ten things flat asks somebody to know which of them is the one they want. The
 * grouping is the only navigation help this screen offers, so it has to agree with the page it
 * navigates to — two different orderings of the same ten links is worse than either ordering.
 */
const GROUPS: {
  label: string;
  items: {
    icon: React.ComponentType<{ className?: string }>;
    linkOptions: LinkOptions;
    title: string;
  }[];
}[] = [
  {
    label: t("What Bots can reach"),
    items: [
      {
        title: t("Credentials"),
        icon: IconKey,
        linkOptions: { to: "/admin/credentials" },
      },
      {
        title: t("Boundaries"),
        icon: IconShieldCheck,
        linkOptions: { to: "/admin/boundaries" },
      },
      {
        title: t("Approvals"),
        icon: IconChecks,
        linkOptions: { to: "/admin/approvals" },
      },
      {
        title: t("Computers"),
        icon: IconDeviceDesktop,
        linkOptions: { to: "/admin/computers" },
      },
    ],
  },
  {
    label: t("What Bots can do"),
    items: [
      {
        title: t("Plugins"),
        icon: IconPuzzle,
        linkOptions: { to: "/admin/plugins" },
      },
      {
        title: t("Skills"),
        icon: IconFileText,
        linkOptions: { to: "/admin/skills" },
      },
      {
        title: t("Automatic learning"),
        icon: IconFileText,
        linkOptions: { to: "/admin/learning" },
      },
      {
        title: t("UI components"),
        icon: IconLayoutGrid,
        linkOptions: { to: "/admin/components" },
      },
      {
        title: t("Playground"),
        icon: IconCode,
        linkOptions: { to: "/admin/playground" },
      },
    ],
  },
  {
    label: t("Who can get in"),
    items: [
      {
        title: t("People"),
        icon: IconUsers,
        linkOptions: { to: "/admin/people" },
      },
      {
        title: t("Identity providers"),
        icon: IconBuildingBank,
        linkOptions: { to: "/admin/identity-providers" },
      },
    ],
  },
  {
    label: t("What happened"),
    items: [
      {
        title: t("Audit"),
        icon: IconListDetails,
        linkOptions: { to: "/admin/audit" },
      },
    ],
  },
];

export function AdminSidebar({
  ...props
}: React.ComponentProps<typeof Sidebar>) {
  return (
    <Sidebar {...props}>
      {/*
       * Pinned to the same height as the app sidebar's header. Left to itself this one is 60px
       * against the app's 45px — `p-2` around a `size="lg"` button rather than a fixed height — so
       * the nav list started lower here and the sidebar appeared to shift on the way into Admin.
       *
       * The button takes its default height rather than `h-full`. `h-full` resolves against the
       * parent, which in the app sidebar is a flex row holding a second control and here is not, so
       * the same class produces two different heights.
       */}
      <SidebarHeader className="h-12 p-2">
        <SidebarMenu>
          <SidebarMenuItem>
            <SidebarMenuButton
              render={(props) => (
                <Link {...appLinkOptions} {...props}>
                  <IconArrowLeft className="mr-2 h-4 w-4" />
                  {t("Back to app")}
                </Link>
              )}
            />
          </SidebarMenuItem>
        </SidebarMenu>
      </SidebarHeader>
      <SidebarContent>
        <SidebarGroup>
          <SidebarMenu>
            <SidebarMenuItem>
              {/*
               * `activeOptions.exact`, because /admin is a prefix of every other route here and
               * would otherwise light up on all of them.
               */}
              <SidebarMenuButton
                render={(props) => (
                  <Link
                    {...adminLinkOptions}
                    activeOptions={{ exact: true }}
                    activeProps={{ className: "bg-foreground/5" }}
                    {...props}
                  >
                    {t("Overview")}
                  </Link>
                )}
              />
            </SidebarMenuItem>
          </SidebarMenu>
        </SidebarGroup>
        {GROUPS.map((group) => (
          <SidebarGroup key={group.label}>
            <SidebarGroupLabel>{group.label}</SidebarGroupLabel>
            <SidebarMenu className="gap-px">
              {group.items.map((item) => (
                <SidebarMenuItem key={item.title}>
                  <SidebarMenuButton
                    render={(props) => (
                      <Link
                        {...item.linkOptions}
                        activeProps={{ className: "bg-foreground/5" }}
                        {...props}
                      >
                        <item.icon className="mr-2 h-4 w-4" />
                        {item.title}
                      </Link>
                    )}
                  />
                </SidebarMenuItem>
              ))}
            </SidebarMenu>
          </SidebarGroup>
        ))}
      </SidebarContent>
      <SidebarRail />
    </Sidebar>
  );
}
