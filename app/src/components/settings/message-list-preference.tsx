import { useMutation, useQueryClient } from "@tanstack/react-query";
import { ChannelItemContent } from "@/components/app-sidebar/channel-item-content";
import { PageRows } from "@/components/layout/page-shell";
import { Button } from "@/components/ui/button";
import {
  Item,
  ItemActions,
  ItemContent,
  ItemDescription,
  ItemTitle,
} from "@/components/ui/item";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  saveUserPreferencesMutationOptions,
  useUserPreferences,
} from "@/lib/settings/message-list";
import { t } from "@/lib/i18n";

export function MessageListPreference() {
  const preferences = useUserPreferences();
  const queryClient = useQueryClient();
  const save = useMutation(
    saveUserPreferencesMutationOptions(queryClient, preferences.userId),
  );
  const emphasis =
    (save.isPending ? save.variables?.messageListEmphasis : undefined) ??
    preferences.data?.messageListEmphasis;

  return (
    <PageRows>
      <Item size="sm">
        <ItemContent>
          <ItemTitle>{t("Message list emphasis")}</ItemTitle>
          <ItemDescription>
            {t("Choose which line stands out in the sidebar.")}
          </ItemDescription>
        </ItemContent>
        <ItemActions>
          <Select
            value={emphasis ?? null}
            disabled={!preferences.data || save.isPending}
            onValueChange={(value) => {
              if (value === "agent" || value === "thread") {
                save.mutate({ messageListEmphasis: value });
              }
            }}
          >
            <SelectTrigger aria-label={t("Message list emphasis")}>
              <SelectValue>
                {emphasis
                  ? emphasis === "agent"
                    ? "Bot name"
                    : "Conversation title"
                  : t("Loading…")}
              </SelectValue>
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="thread">{t("Conversation title")}</SelectItem>
              <SelectItem value="agent">{t("Bot name")}</SelectItem>
            </SelectContent>
          </Select>
        </ItemActions>
      </Item>
      {preferences.isError ? (
        <div className="px-3 pb-3">
          <p role="alert" className="text-sm text-destructive">
            {preferences.error.message}
          </p>
          <Button
            variant="ghost"
            size="sm"
            onClick={() => void preferences.refetch()}
          >
            {t("Try again")}
          </Button>
        </div>
      ) : null}
      {save.isError ? (
        <p role="alert" className="px-3 pb-3 text-sm text-destructive">
          {save.error.message}
        </p>
      ) : null}
      {save.isPending ? (
        <p role="status" className="px-3 text-sm text-muted-foreground">
          {t("Saving…")}
        </p>
      ) : null}
      {emphasis ? (
        <div className="flex justify-center px-6 pt-3 pb-6">
          <figure
            aria-label={t("Message list preview")}
            className="flex h-16 w-full max-w-xs items-center rounded-lg border border-border bg-sidebar px-3"
          >
            <ChannelItemContent
              participantIds={["message-list-preview"]}
              name="General Assistant"
              title={t("Plan next week")}
              lastMessageAt="2h"
              emphasis={emphasis}
            />
          </figure>
        </div>
      ) : null}
    </PageRows>
  );
}
