import { IconHandStop, IconMessageQuestion } from "@tabler/icons-react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { Fragment, useState } from "react";
import { PageRows, PageSection } from "@/components/layout/page-shell";
import { Button } from "@/components/ui/button";
import {
  Item,
  ItemContent,
  ItemDescription,
  ItemFooter,
  ItemMedia,
  ItemTitle,
} from "@/components/ui/item";
import { Separator } from "@/components/ui/separator";
import { Textarea } from "@/components/ui/textarea";
import { agentListQueryOptions } from "@/lib/agents/queries";
import {
  answerPersonQuestionMutationOptions,
  approvalInboxOptions,
  decideApprovalMutationOptions,
} from "@/lib/approvals";
import { queryClient } from "@/query-client";
import { t } from "@/lib/i18n";

/**
 * Questions and actions waiting on the person, one row each, decided where it is shown: the answer
 * box and the decision buttons sit on the row's own footer line. Given a Bot, only that Bot's. The
 * same requests the conversation draws inline, so a decision made in either place is the one
 * decision.
 */
export function WaitingForYou({ agentId }: { agentId?: string }) {
  const inbox = useQuery(approvalInboxOptions());
  const agents = useQuery(agentListQueryOptions());
  const botName = (id: string) =>
    agents.data?.find((agent) => agent.id === id)?.name ?? id;
  const decision = useMutation(decideApprovalMutationOptions(queryClient));
  const [answers, setAnswers] = useState<Record<string, string>>({});
  const answer = useMutation(answerPersonQuestionMutationOptions(queryClient));
  const ours = (botId: string) => agentId === undefined || botId === agentId;
  const questions = (inbox.data?.questions ?? []).filter((question) =>
    ours(question.conversationBotId ?? question.botId),
  );
  const pending = (inbox.data?.requests ?? []).filter(
    (request) => request.status === "pending" && ours(request.action.botId),
  );
  const error = inbox.error ?? decision.error ?? answer.error;
  return (
    <>
      {error ? (
        <p role="alert" className="mt-4 text-sm text-destructive">
          {error.message}
        </p>
      ) : null}
      {questions.length + pending.length > 0 ? (
        <PageRows>
          {questions.map((question, index) => (
            <Fragment key={question.id}>
              {index > 0 ? <Separator /> : null}
              <Item size="sm">
                <ItemMedia variant="icon">
                  <IconMessageQuestion />
                </ItemMedia>
                <ItemContent>
                  <ItemTitle className="line-clamp-none">
                    {botName(question.botId)} {t("asks:")} {question.question}
                  </ItemTitle>
                  {question.why ? (
                    <ItemDescription className="line-clamp-none">
                      {question.why}
                    </ItemDescription>
                  ) : null}
                </ItemContent>
                <ItemFooter className="flex-col items-start">
                  <Textarea
                    aria-label={t("Your answer")}
                    onChange={(event) =>
                      setAnswers((prior) => ({
                        ...prior,
                        [question.id]: event.target.value,
                      }))
                    }
                    placeholder={t("Your answer")}
                    value={answers[question.id] ?? ""}
                  />
                  <Button
                    disabled={answer.isPending || !answers[question.id]?.trim()}
                    onClick={() =>
                      answer.mutate({
                        id: question.id,
                        response: answers[question.id] ?? "",
                      })
                    }
                    size="sm"
                  >
                    {t("Send answer")}
                  </Button>
                </ItemFooter>
              </Item>
            </Fragment>
          ))}
          {pending.map((request, index) => (
            <Fragment key={request.id}>
              {questions.length + index > 0 ? <Separator /> : null}
              <Item size="sm">
                <ItemMedia variant="icon">
                  <IconHandStop />
                </ItemMedia>
                <ItemContent className="min-w-0">
                  <ItemTitle className="line-clamp-none">
                    {botName(request.action.botId)} {t("wants to")}{" "}
                    {request.action.toolRef
                      .replace(/^computer_|^host\//, "")
                      .replaceAll("_", " ")}
                  </ItemTitle>
                  <ItemDescription className="line-clamp-none break-all">
                    {request.action.scope}
                  </ItemDescription>
                  {request.action.policy ? (
                    <p className="text-sm">
                      {request.action.policy.behaviour === "hand_off"
                        ? t("Handed to you: ")
                        : ""}
                      {request.action.policy.reason}
                    </p>
                  ) : null}
                  <pre className="mt-1 max-h-52 overflow-auto whitespace-pre-wrap rounded bg-muted p-3 text-xs">
                    {JSON.stringify(request.action.args, null, 2)}
                  </pre>
                </ItemContent>
                {request.action.policy?.behaviour === "hand_off" ? (
                  <ItemFooter className="flex-wrap justify-start">
                    <Button
                      disabled={decision.isPending}
                      onClick={() =>
                        decision.mutate({ id: request.id, choice: "handled" })
                      }
                      size="sm"
                    >
                      {t("I did it myself")}
                    </Button>
                    <Button
                      disabled={decision.isPending}
                      onClick={() =>
                        decision.mutate({ id: request.id, choice: "deny" })
                      }
                      size="sm"
                      variant="outline"
                    >
                      {t("Don't do it")}
                    </Button>
                  </ItemFooter>
                ) : (
                  <ItemFooter className="flex-wrap justify-start">
                    <Button
                      disabled={decision.isPending}
                      onClick={() =>
                        decision.mutate({
                          id: request.id,
                          choice: "allow_once",
                        })
                      }
                      size="sm"
                    >
                      {t("Allow once")}
                    </Button>
                    <Button
                      disabled={decision.isPending}
                      onClick={() =>
                        decision.mutate({
                          id: request.id,
                          choice: "allow_always",
                        })
                      }
                      size="sm"
                      variant="outline"
                    >
                      {t("Always allow here")}
                    </Button>
                    <Button
                      disabled={decision.isPending}
                      onClick={() =>
                        decision.mutate({ id: request.id, choice: "deny" })
                      }
                      size="sm"
                      variant="outline"
                    >
                      {t("Deny")}
                    </Button>
                  </ItemFooter>
                )}
              </Item>
            </Fragment>
          ))}
        </PageRows>
      ) : null}
    </>
  );
}

/**
 * What one Bot is waiting on the person for, at the top of its page. Nothing is drawn when nothing
 * waits: the sidebar's badge already said whether to look.
 */
export function BotNeedsYou({ agentId }: { agentId: string }) {
  const inbox = useQuery(approvalInboxOptions());
  const waiting =
    (inbox.data?.questions ?? []).some(
      (question) => (question.conversationBotId ?? question.botId) === agentId,
    ) ||
    (inbox.data?.requests ?? []).some(
      (request) =>
        request.status === "pending" && request.action.botId === agentId,
    );
  if (!waiting) return null;
  return (
    <PageSection title={t("Needs you")}>
      <WaitingForYou agentId={agentId} />
    </PageSection>
  );
}
