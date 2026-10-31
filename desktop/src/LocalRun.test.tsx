import { afterAll, afterEach, beforeAll, expect, mock, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { cleanup, fireEvent, render } from "@testing-library/react";

import { LocalRun, type LocalStatus } from "./LocalRun";

const onStart = mock(() => undefined);
const onStop = mock(() => undefined);
const onChooseWorkspace = mock(() => undefined);

beforeAll(() => GlobalRegistrator.register());
afterEach(() => {
  onStart.mockClear();
  onStop.mockClear();
  onChooseWorkspace.mockClear();
  cleanup();
});
afterAll(() => GlobalRegistrator.unregister());

function status(overrides: Partial<LocalStatus> = {}): LocalStatus {
  return {
    supported: true,
    wanted: false,
    database_port: null,
    database_running: false,
    interface_built: false,
    health: null,
    bot_port: null,
    bot_health: null,
    workspace: "C:\\CCP-Bot\\workspace",
    computer_port: null,
    computer_health: null,
    address: "http://127.0.0.1:3010",
    step: "",
    step_detail: "",
    ...overrides,
  };
}

test("local_run_promises_what_a_first_run_will_do", () => {
  const view = render(
    <LocalRun status={null} busy={false} onStart={onStart} onStop={onStop}
      onChooseWorkspace={onChooseWorkspace} />,
  );

  // The five things it will bring, and the three things it will not need.
  expect(view.getByText("Portable database")).toBeTruthy();
  expect(view.getByText("Interface")).toBeTruthy();
  expect(view.getByText("Services")).toBeTruthy();
  expect(view.getByText("A Bot of your own")).toBeTruthy();
  expect(view.getByText("Hands on your files")).toBeTruthy();
  expect(
    view.getByText("No Docker, no virtual machine, no administrator"),
  ).toBeTruthy();
  expect(view.queryByText("Ready")).toBeNull();
  expect(view.getAllByText("Not yet")).toHaveLength(5);

  fireEvent.click(view.getByRole("button", { name: "Start on this computer" }));
  expect(onStart).toHaveBeenCalledTimes(1);
  expect(onStop).not.toHaveBeenCalled();
  expect(view.queryByRole("button", { name: "Stop CCP-Bot" })).toBeNull();

  // Which folder a Bot works in is the one setting a person has to make, so it is a button next to
  // Start rather than a line to edit in a file.
  fireEvent.click(
    view.getByRole("button", { name: "Choose the folder a Bot works in" }),
  );
  expect(onChooseWorkspace).toHaveBeenCalledTimes(1);
});

test("local_run_distinguishes_prepared_from_running", () => {
  const view = render(
    <LocalRun
      status={status({
        wanted: true,
        database_port: 63133,
        database_running: false,
        interface_built: true,
      })}
      busy={false}
      onStart={onStart}
      onStop={onStop}
      onChooseWorkspace={onChooseWorkspace}
    />,
  );

  // A machine that has run before is not a machine that has never run: the archive is unpacked and
  // the port is remembered, and the screen says so.
  expect(
    view.getByText("Prepared (port 63133). The first run downloads it once."),
  ).toBeTruthy();
  expect(
    view.getByText("Built. The server serves it on the address below."),
  ).toBeTruthy();
  expect(
    view.getByText(
      "The server and the connected agents, as programs on this computer.",
    ),
  ).toBeTruthy();
  expect(view.getByRole("button", { name: "Start on this computer" })).toBeTruthy();
});

test("local_run_shows_the_step_it_is_working_on_and_waits_while_busy", () => {
  const view = render(
    <LocalRun
      status={status({
        wanted: true,
        step: "database",
        step_detail: "Starting the database…",
      })}
      busy={true}
      onStart={onStart}
      onStop={onStop}
      onChooseWorkspace={onChooseWorkspace}
    />,
  );

  expect(view.getByText("Database")).toBeTruthy();
  expect(view.getByText("In progress")).toBeTruthy();
  expect(view.getByText("Starting the database…")).toBeTruthy();

  const start = view.getByRole("button", { name: "Starting…" });
  expect(start.hasAttribute("disabled")).toBe(true);
  fireEvent.click(start);
  expect(onStart).not.toHaveBeenCalled();
});

test("local_run_offers_stop_once_it_answers", () => {
  const view = render(
    <LocalRun
      status={status({
        wanted: true,
        database_port: 63133,
        database_running: true,
        interface_built: true,
        health: 200,
      })}
      busy={false}
      onStart={onStart}
      onStop={onStop}
      onChooseWorkspace={onChooseWorkspace}
    />,
  );

  expect(view.getByText("Answering on http://127.0.0.1:3010.")).toBeTruthy();
  expect(
    view.getByText("Running on port 63133, on this computer only."),
  ).toBeTruthy();
  fireEvent.click(view.getByRole("button", { name: "Stop CCP-Bot" }));
  expect(onStop).toHaveBeenCalledTimes(1);
});

test("local_run_names_the_bot_it_brought_along", () => {
  const prepared = render(
    <LocalRun
      status={status({ wanted: true, database_port: 63133, bot_port: 63659 })}
      busy={false}
      onStart={onStart}
      onStop={onStop}
      onChooseWorkspace={onChooseWorkspace}
    />,
  );

  // Prepared is not running: the port is known and remembered, and the Bot answers only once the
  // services are up.
  expect(
    prepared.getByText("Prepared (port 63659). It answers once the services are up."),
  ).toBeTruthy();
  cleanup();

  const answering = render(
    <LocalRun
      status={status({
        wanted: true,
        health: 200,
        bot_port: 63659,
        bot_health: 200,
      })}
      busy={false}
      onStart={onStart}
      onStop={onStop}
      onChooseWorkspace={onChooseWorkspace}
    />,
  );

  expect(
    answering.getByText("Answering on http://127.0.0.1:63659/ag-ui."),
  ).toBeTruthy();
});

test("local_run_says_where_a_bot_can_actually_work", () => {
  const prepared = render(
    <LocalRun
      status={status({
        wanted: true,
        database_port: 63133,
        workspace: "D:\\my-project",
        computer_port: 6210,
      })}
      busy={false}
      onStart={onStart}
      onStop={onStop}
      onChooseWorkspace={onChooseWorkspace}
    />,
  );

  // Knowing the port is not the same as knowing it can touch anything: the folder is what a person
  // needs to see, and it is the folder local mode was pointed at.
  expect(
    prepared.getByText("Prepared (port 6210). It starts with the services."),
  ).toBeTruthy();
  cleanup();

  const working = render(
    <LocalRun
      status={status({
        wanted: true,
        health: 200,
        workspace: "D:\\my-project",
        computer_port: 6210,
        computer_health: 200,
      })}
      busy={false}
      onStart={onStart}
      onStop={onStop}
      onChooseWorkspace={onChooseWorkspace}
    />,
  );

  expect(
    working.getByText(
      "Working in D:\\my-project. It reads, writes and runs commands there.",
    ),
  ).toBeTruthy();
});